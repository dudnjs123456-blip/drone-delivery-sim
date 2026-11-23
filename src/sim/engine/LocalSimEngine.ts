/**
 * 자체 단순 물리 엔진.
 * 비행 단계 상태 머신:
 *   IDLE ─(FLY_MISSION)→ TAKEOFF → CRUISE → DESCEND → LANDED ─(하역 대기)→ RETURN ─(도크 착륙)→ IDLE
 * RETURN 은 스테이션 이륙부터 도크 착륙까지 전체이며, 내부적으로 이륙·순항·하강 구간을 재사용한다.
 */
import type { SimConfig } from '../config';
import { drainBattery } from '../flight/battery';
import { type MotionLimits, limitsFromConfig, stepAlongPath } from '../flight/kinematics';
import { type Leg, buildTripLegs, flattenLegs } from '../flight/route';
import { PathPlanner } from '../pathfinding/planner';
import type { Dock, Drone, FlightPhase, MapData, Order, Station, Vec3, WindState } from '../types';
import { clone } from '../util/vec3';
import type { DispatchResult, PhaseChange, SimCommand, SimEngine, SimEvent, SimSnapshot } from './SimEngine';

const PHASE_LOG_LIMIT = 500;
const RETURN_RETRY_SEC = 10;

interface Trip {
  kind: 'OUTBOUND' | 'RETURN';
  legs: Leg[];
  offsets: number[];
  stationId: string;
}

interface DroneRuntime {
  drone: Drone;
  trip: Trip | null;
  legIndex: number;
  wpIndex: number;
  /** LANDED 상태에서 복귀를 시작하는 시각 */
  dwellUntil: number;
  /** 하역을 마친 스테이션 (복귀 출발점) */
  stationId: string | null;
}

const AIRBORNE: ReadonlySet<FlightPhase> = new Set(['TAKEOFF', 'CRUISE', 'DESCEND', 'RETURN']);

export class LocalSimEngine implements SimEngine {
  private map!: MapData;
  private config!: SimConfig;
  private seed = 0;
  private limits!: MotionLimits;
  private planner!: PathPlanner;
  private plannerKey: { map: MapData; config: SimConfig } | null = null;
  private time = 0;
  private runtimes: DroneRuntime[] = [];
  private byId = new Map<string, DroneRuntime>();
  private docks = new Map<string, Dock>();
  private stations = new Map<string, Station>();
  private drones: Drone[] = [];
  private orders: Order[] = [];
  private wind: WindState = { fromDirRad: 0, meanSpeed: 0, gustSpeed: 0 };
  private phaseLog: PhaseChange[] = [];
  private listeners = new Set<(e: SimEvent) => void>();
  private snapshot!: SimSnapshot;

  load(map: MapData, config: SimConfig, seed: number): void {
    this.map = map;
    this.config = config;
    this.seed = seed;
    this.limits = limitsFromConfig(config);
    // 격자 생성이 비싸므로 같은 지도·설정이면 재사용한다 (reset 포함)
    if (!this.plannerKey || this.plannerKey.map !== map || this.plannerKey.config !== config) {
      this.planner = new PathPlanner(map, config);
      this.plannerKey = { map, config };
    }
    this.docks = new Map(map.docks.map((d) => [d.id, d]));
    this.stations = new Map(map.stations.map((s) => [s.id, s]));
    this.time = 0;
    this.orders = [];
    this.phaseLog = [];
    this.wind = { fromDirRad: 0, meanSpeed: 0, gustSpeed: 0 };

    if (map.docks.length === 0) throw new Error('도크가 없는 지도에서는 드론을 배치할 수 없습니다');
    this.runtimes = [];
    for (let i = 0; i < config.fleet.droneCount; i++) {
      const dock = map.docks[i % map.docks.length];
      const drone: Drone = {
        id: `D${String(i + 1).padStart(2, '0')}`,
        phase: 'IDLE',
        position: clone(dock.position),
        velocity: { x: 0, y: 0, z: 0 },
        headingRad: 0,
        battery: 1,
        payloadKg: 0,
        homeDockId: dock.id,
        orderId: null,
        path: [],
        pathIndex: 0,
        route: null,
      };
      this.runtimes.push({ drone, trip: null, legIndex: 0, wpIndex: 1, dwellUntil: 0, stationId: null });
    }
    this.byId = new Map(this.runtimes.map((r) => [r.drone.id, r]));
    this.drones = this.runtimes.map((r) => r.drone);
    this.rebuildSnapshot();
  }

  reset(): void {
    this.load(this.map, this.config, this.seed);
  }

  getSnapshot(): SimSnapshot {
    this.snapshot.time = this.time;
    return this.snapshot;
  }

  subscribe(fn: (e: SimEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  dispatch(cmd: SimCommand): DispatchResult {
    switch (cmd.type) {
      case 'FLY_MISSION':
        return this.flyMission(cmd);
      case 'CREATE_ORDER':
      case 'SET_PEAK_MODE':
      case 'SET_WIND':
        // M4 (주문), M5 (바람) 에서 구현
        return { ok: false, reason: `${cmd.type} 는 아직 구현되지 않았습니다` };
    }
  }

  step(dt: number): void {
    this.time += dt;
    const windSpeed = this.wind.meanSpeed;
    for (const rt of this.runtimes) {
      const d = rt.drone;
      if (d.phase === 'LANDED' && this.time >= rt.dwellUntil) this.startReturn(rt);
      if (rt.trip) this.advanceTrip(rt, dt);
      if (AIRBORNE.has(d.phase)) {
        d.battery = drainBattery(d.battery, dt, this.config, windSpeed);
        const hs = Math.hypot(d.velocity.x, d.velocity.y);
        // 방위각: 북 = 0, 시계 방향
        if (hs > 0.3) d.headingRad = Math.atan2(d.velocity.x, d.velocity.y);
      }
    }
  }

  // ── 내부 ──

  private flyMission(cmd: Extract<SimCommand, { type: 'FLY_MISSION' }>): DispatchResult {
    const dock = this.docks.get(cmd.fromDockId);
    const station = this.stations.get(cmd.toStationId);
    if (!dock) return { ok: false, reason: `없는 도크: ${cmd.fromDockId}` };
    if (!station) return { ok: false, reason: `없는 스테이션: ${cmd.toStationId}` };

    const rt = cmd.droneId
      ? this.byId.get(cmd.droneId)
      : (this.runtimes.find((r) => r.drone.phase === 'IDLE' && r.drone.homeDockId === dock.id) ??
        this.runtimes.find((r) => r.drone.phase === 'IDLE'));
    if (!rt) return { ok: false, reason: '대기 중인 드론이 없습니다' };
    if (rt.drone.phase !== 'IDLE') return { ok: false, reason: `${rt.drone.id} 는 이미 비행 중입니다` };

    const payload = cmd.payloadKg ?? this.config.fleet.missionPayloadKg;
    if (payload > this.config.drone.maxPayloadKg) {
      return { ok: false, reason: `탑재 중량 ${payload}kg 이 최대 ${this.config.drone.maxPayloadKg}kg 을 넘습니다` };
    }

    // 복귀 경로도 있는지 먼저 확인한다 (가서 못 돌아오는 일이 없게)
    const back = this.planCruise(station.position, dock.position);
    if (!back.ok) return { ok: false, reason: `복귀 경로 없음: ${back.reason}` };
    const out = this.planCruise(dock.position, station.position);
    if (!out.ok) return { ok: false, reason: `경로 없음: ${out.reason}` };

    // 대기 중인 드론은 다른 도크로 옮겨 배치할 수 있다 (시험 비행용)
    if (rt.drone.homeDockId !== dock.id) {
      rt.drone.homeDockId = dock.id;
      rt.drone.position = clone(dock.position);
    }
    rt.drone.payloadKg = payload;
    this.startTrip(rt, 'OUTBOUND', dock.position, station.position, station.id, out);
    this.setPhase(rt, 'TAKEOFF');
    return { ok: true };
  }

  /** 순항 고도에서 출발 패드 상공 → 도착 패드 상공 경로를 탐색한다 */
  private planCruise(from: Vec3, to: Vec3) {
    const z = this.config.altitude.cruiseM;
    return this.planner.plan({ x: from.x, y: from.y, z }, { x: to.x, y: to.y, z });
  }

  private startTrip(
    rt: DroneRuntime,
    kind: Trip['kind'],
    from: Vec3,
    to: Vec3,
    stationId: string,
    plan: Extract<ReturnType<PathPlanner['plan']>, { ok: true }>,
  ) {
    // 계획 경로의 양 끝(패드 상공)은 buildTripLegs 가 붙이므로 중간점만 넘긴다
    const legs = buildTripLegs(from, to, this.config.altitude.cruiseM, plan.path.slice(1, -1));
    const a = plan.path[0];
    const b = plan.path[plan.path.length - 1];
    rt.drone.route = {
      rawPath: plan.rawPath,
      lengthM: plan.lengthM,
      straightM: Math.hypot(b.x - a.x, b.y - a.y),
      estCruiseSec: plan.estFlightSec,
      expandedNodes: plan.expanded,
      computeMs: plan.computeMs,
    };
    const { path, offsets } = flattenLegs(legs);
    rt.trip = { kind, legs, offsets, stationId };
    rt.legIndex = 0;
    rt.wpIndex = 1;
    rt.drone.path = path;
    rt.drone.pathIndex = 1;
  }

  private startReturn(rt: DroneRuntime) {
    const station = rt.stationId ? this.stations.get(rt.stationId) : undefined;
    const dock = this.docks.get(rt.drone.homeDockId);
    if (!station || !dock) return;
    const plan = this.planCruise(station.position, dock.position);
    if (!plan.ok) {
      // 출발 전에 확인했으므로 보통 일어나지 않는다. 잠시 후 다시 시도
      rt.dwellUntil = this.time + RETURN_RETRY_SEC;
      return;
    }
    this.startTrip(rt, 'RETURN', station.position, dock.position, station.id, plan);
    this.setPhase(rt, 'RETURN');
  }

  private advanceTrip(rt: DroneRuntime, dt: number) {
    const trip = rt.trip!;
    const leg = trip.legs[rt.legIndex];
    const res = stepAlongPath(rt.drone, leg.waypoints, rt.wpIndex, this.limits, dt);
    rt.wpIndex = res.wpIndex;
    rt.drone.pathIndex = trip.offsets[rt.legIndex] + rt.wpIndex;
    if (!res.done) return;

    rt.legIndex++;
    rt.wpIndex = 1;
    if (rt.legIndex < trip.legs.length) {
      if (trip.kind === 'OUTBOUND') this.setPhase(rt, trip.legs[rt.legIndex].kind);
      return;
    }

    // 구간을 모두 마쳤다
    rt.trip = null;
    rt.drone.path = [];
    rt.drone.pathIndex = 0;
    rt.drone.route = null;
    if (trip.kind === 'OUTBOUND') {
      rt.stationId = trip.stationId;
      rt.drone.payloadKg = 0;
      rt.dwellUntil = this.time + this.config.drone.stationDwellSec;
      this.setPhase(rt, 'LANDED');
    } else {
      rt.stationId = null;
      this.setPhase(rt, 'IDLE');
    }
  }

  private setPhase(rt: DroneRuntime, to: FlightPhase) {
    const from = rt.drone.phase;
    if (from === to) return;
    rt.drone.phase = to;
    const change: PhaseChange = { t: this.time, droneId: rt.drone.id, from, to };
    this.phaseLog.push(change);
    if (this.phaseLog.length > PHASE_LOG_LIMIT) this.phaseLog.splice(0, this.phaseLog.length - PHASE_LOG_LIMIT);
    this.emit({ type: 'PHASE_CHANGED', ...change });
  }

  private emit(e: SimEvent) {
    for (const fn of this.listeners) fn(e);
  }

  private rebuildSnapshot() {
    this.snapshot = {
      time: this.time,
      drones: this.drones,
      orders: this.orders,
      wind: this.wind,
      activeAlerts: [],
      phaseLog: this.phaseLog,
    };
  }
}
