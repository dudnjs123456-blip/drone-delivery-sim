/**
 * 자체 단순 물리 엔진 (다중 드론).
 *
 * 비행 단계: IDLE ─(배정·출발 시각)→ TAKEOFF → CRUISE → DESCEND → LANDED ─(하역)→ RETURN → IDLE
 * RETURN 은 스테이션 이륙부터 도크 착륙까지 전체이며, 이륙·순항·하강 구간을 재사용한다.
 *
 * 배정(dispatch)
 * - 1초(예약 시간 칸)마다 대기 주문을 FIFO 로 처리한다. 가게의 도크에 있는 대기 드론 중 배터리가 많은 순.
 * - 후보 (출발 지연 × 순항 고도 × 착륙 패드) 마다 왕복 궤적을 stepMission 으로 예측하고,
 *   예약 테이블·패드 점유와 겹치지 않는 첫 후보를 확정한다 (지연이 작은 쪽, 같은 지연이면 낮은 고도 우선).
 * - 바람이 없으면 예측과 실제 비행이 같은 함수로 계산되므로 정확히 일치한다.
 */
import type { SimConfig } from '../config';
import { drainBattery } from '../flight/battery';
import { type MotionLimits, limitsFromConfig } from '../flight/kinematics';
import { type MissionLegs, type MissionProgress, isAirborneStage, newProgress, stepMission } from '../flight/mission';
import { type Leg, buildTripLegs, flattenLegs } from '../flight/route';
import { dockLaunchPads, dockParking, stationPads } from '../map/pads';
import { type PlanResult, PathPlanner } from '../pathfinding/planner';
import { type MissionPrediction, predictMission } from '../traffic/predict';
import { ReservationTable } from '../traffic/reservationTable';
import { findSeparationViolations } from '../traffic/separation';
import type { Dock, Drone, FlightPhase, MapData, Order, RouteInfo, Station, Vec3, WindState } from '../types';
import { Rng } from '../util/rng';
import { clone } from '../util/vec3';
import type {
  DispatchResult,
  PhaseChange,
  SimCommand,
  SimEngine,
  SimEvent,
  SimSnapshot,
  TrafficStats,
} from './SimEngine';

const PHASE_LOG_LIMIT = 2000;
/** 예약 테이블에서 지난 칸을 지우는 주기 (s) */
const PRUNE_EVERY_SEC = 30;

interface Mission {
  orderId: string | null;
  stationId: string;
  padIndex: number;
  /** 출발·복귀하는 도크 패드 */
  dockPad: Vec3;
  legs: MissionLegs;
  progress: MissionProgress;
  outPath: Vec3[];
  outOffsets: number[];
  backPath: Vec3[];
  backOffsets: number[];
  outRoute: RouteInfo;
  backRoute: RouteInfo;
  cruiseAltM: number;
}

interface DroneRuntime {
  drone: Drone;
  /** 홈 도크 격납고 칸 (대기 위치) */
  slot: Vec3;
  mission: Mission | null;
}

interface Candidate {
  legs: Omit<MissionLegs, 'departStep'>;
  pred: MissionPrediction;
  outPath: Vec3[];
  outOffsets: number[];
  backPath: Vec3[];
  backOffsets: number[];
  outRoute: RouteInfo;
  backRoute: RouteInfo;
  outAlt: number;
  backAlt: number;
  padIndex: number;
  dockPadIndex: number;
  dockPad: Vec3;
}

type ScheduleResult = { ok: true } | { ok: false; reason: 'battery' | 'traffic' | 'route'; detail: string };

const AIRBORNE: ReadonlySet<FlightPhase> = new Set(['TAKEOFF', 'CRUISE', 'DESCEND', 'RETURN']);

export class LocalSimEngine implements SimEngine {
  private map!: MapData;
  private config!: SimConfig;
  private seed = 0;
  private dt = 0.05;
  private limits!: MotionLimits;
  private planner!: PathPlanner;
  private plannerKey: { map: MapData; config: SimConfig } | null = null;
  private routeCache = new Map<string, PlanResult>();
  /** (드론 슬롯, 스테이션 패드, 고도) → 왕복 궤적 예측. 바람이 없으면 결정적이라 재사용한다 */
  private candidateCache = new Map<string, Candidate | null>();

  private stepCount = 0;
  private stepsPerSlot = 20;
  private rng = new Rng(1);
  private runtimes: DroneRuntime[] = [];
  private byId = new Map<string, DroneRuntime>();
  private docks = new Map<string, Dock>();
  private stations = new Map<string, Station>();
  private pads = new Map<string, Vec3[]>();
  private dockPads = new Map<string, Vec3[]>();
  /** `${stationId}#${pad}` → 점유 구간 [from, to] (스텝) */
  private padBusy = new Map<string, { from: number; to: number }[]>();
  private table!: ReservationTable;
  private useReservations = true;

  private drones: Drone[] = [];
  private orders: Order[] = [];
  private ordersById = new Map<string, Order>();
  private queue: string[] = [];
  /** 주문별 다음 배정 시도 스텝 (혼잡으로 실패한 경우) */
  private retryAt = new Map<string, number>();
  private orderSeq = 0;
  private peak: { perMin: number; nextStep: number } | null = null;

  private wind: WindState = { fromDirRad: 0, meanSpeed: 0, gustSpeed: 0 };
  private phaseLog: PhaseChange[] = [];
  private activePairs = new Map<string, SimEvent>();
  private alerts: SimEvent[] = [];
  private violationEvents = 0;
  private missionsScheduled = 0;
  private trafficDelaySumSec = 0;
  private altitudeShifted = 0;
  private listeners = new Set<(e: SimEvent) => void>();
  private snapshot!: SimSnapshot;

  load(map: MapData, config: SimConfig, seed: number): void {
    this.map = map;
    this.config = config;
    this.seed = seed;
    this.dt = config.time.fixedDtSec;
    this.limits = limitsFromConfig(config);
    if (!this.plannerKey || this.plannerKey.map !== map || this.plannerKey.config !== config) {
      // 격자 생성이 비싸므로 같은 지도·설정이면 재사용한다 (reset 포함)
      this.planner = new PathPlanner(map, config);
      this.plannerKey = { map, config };
      this.routeCache.clear();
    }
    this.stepsPerSlot = Math.round(config.traffic.slotSec / this.dt);
    this.candidateCache.clear();
    this.docks = new Map(map.docks.map((d) => [d.id, d]));
    this.stations = new Map(map.stations.map((s) => [s.id, s]));
    this.pads = new Map(map.stations.map((s) => [s.id, stationPads(s)]));
    this.dockPads = new Map(map.docks.map((d) => [d.id, dockLaunchPads(map, d)]));
    this.padBusy.clear();
    const { minX, minY, maxX, maxY } = map.bounds;
    this.table = new ReservationTable({ minX, minY, maxX, maxY, maxZ: config.altitude.maxM + 20 }, config.traffic.minSeparationM);
    this.useReservations = config.traffic.useReservations;

    this.stepCount = 0;
    this.rng = new Rng(seed);
    this.orders = [];
    this.ordersById.clear();
    this.queue = [];
    this.retryAt.clear();
    this.orderSeq = 0;
    this.peak = null;
    this.phaseLog = [];
    this.activePairs.clear();
    this.alerts = [];
    this.violationEvents = 0;
    this.missionsScheduled = 0;
    this.trafficDelaySumSec = 0;
    this.altitudeShifted = 0;
    this.wind = { fromDirRad: 0, meanSpeed: 0, gustSpeed: 0 };

    if (map.docks.length === 0) throw new Error('도크가 없는 지도에서는 드론을 배치할 수 없습니다');
    const slotsByDock = new Map(map.docks.map((d) => [d.id, dockParking(map, d)]));
    const used = new Map<string, number>();
    this.runtimes = [];
    for (let i = 0; i < config.fleet.droneCount; i++) {
      const dock = map.docks[i % map.docks.length];
      const n = used.get(dock.id) ?? 0;
      const slots = slotsByDock.get(dock.id)!;
      if (n >= slots.length) throw new Error(`도크 ${dock.id} 의 격납고(${slots.length}칸)보다 드론이 많습니다`);
      used.set(dock.id, n + 1);
      const slot = slots[n];
      const drone: Drone = {
        id: `D${String(i + 1).padStart(2, '0')}`,
        phase: 'IDLE',
        position: clone(slot),
        velocity: { x: 0, y: 0, z: 0 },
        headingRad: 0,
        battery: 1,
        payloadKg: 0,
        homeDockId: dock.id,
        orderId: null,
        path: [],
        pathIndex: 0,
        route: null,
        departAt: null,
        swapUntil: null,
        cruiseAltM: null,
      };
      this.runtimes.push({ drone, slot, mission: null });
    }
    this.byId = new Map(this.runtimes.map((r) => [r.drone.id, r]));
    this.drones = this.runtimes.map((r) => r.drone);
    this.snapshot = {
      time: 0,
      drones: this.drones,
      orders: this.orders,
      wind: this.wind,
      activeAlerts: this.alerts,
      phaseLog: this.phaseLog,
      traffic: this.trafficStats(),
      peakOrdersPerMin: null,
    };
  }

  reset(): void {
    this.load(this.map, this.config, this.seed);
  }

  private get time(): number {
    return this.stepCount * this.dt;
  }

  getSnapshot(): SimSnapshot {
    const s = this.snapshot;
    s.time = this.time;
    s.activeAlerts = this.alerts;
    s.traffic = this.trafficStats();
    s.peakOrdersPerMin = this.peak?.perMin ?? null;
    return s;
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
        return this.createOrder(cmd.storeId, cmd.destBuildingId);
      case 'SET_PEAK_MODE':
        if (cmd.ordersPerMin === null || cmd.ordersPerMin <= 0) this.peak = null;
        else this.peak = { perMin: cmd.ordersPerMin, nextStep: this.stepCount + this.nextArrivalSteps(cmd.ordersPerMin) };
        return { ok: true };
      case 'SET_RESERVATIONS':
        this.useReservations = cmd.enabled;
        return { ok: true };
      case 'SET_WIND':
        // M5 에서 구현
        return { ok: false, reason: 'SET_WIND 는 아직 구현되지 않았습니다' };
    }
  }

  step(dt: number): void {
    this.stepCount++;
    const step = this.stepCount;

    if (this.peak && step >= this.peak.nextStep) {
      this.createOrder();
      this.peak.nextStep = step + this.nextArrivalSteps(this.peak.perMin);
    }

    for (const rt of this.runtimes) this.stepDrone(rt, step, dt);
    this.checkSeparation();

    if (step % this.stepsPerSlot === 0) this.runDispatcher();
    if (step % Math.round(PRUNE_EVERY_SEC / this.dt) === 0) this.prune();
  }

  // ── 드론 진행 ──

  private stepDrone(rt: DroneRuntime, step: number, dt: number) {
    const d = rt.drone;
    const m = rt.mission;
    if (!m) {
      if (d.swapUntil !== null && this.time >= d.swapUntil - 1e-9) {
        d.battery = 1;
        d.swapUntil = null;
      }
      return;
    }

    // 출발 스텝: 격납고에서 이착륙 패드로 옮긴다 (예측도 패드에서 시작한다)
    if (m.progress.stage === 'SCHEDULED' && step >= m.legs.departStep) d.position = clone(m.dockPad);
    const ev = stepMission(m.legs, m.progress, d, step, this.limits, dt);
    const pr = m.progress;
    switch (ev) {
      case 'DEPART': {
        d.departAt = null;
        d.path = m.outPath;
        d.route = m.outRoute;
        this.setPhase(rt, 'TAKEOFF');
        const o = m.orderId ? this.ordersById.get(m.orderId) : undefined;
        if (o) {
          o.status = 'IN_FLIGHT';
          o.t.takeoff = this.time;
        }
        break;
      }
      case 'LEG_CHANGE':
        if (pr.stage === 'OUTBOUND') this.setPhase(rt, m.legs.out[pr.legIndex].kind);
        break;
      case 'LANDED': {
        d.payloadKg = 0;
        d.path = [];
        d.route = null;
        this.setPhase(rt, 'LANDED');
        const o = m.orderId ? this.ordersById.get(m.orderId) : undefined;
        if (o) {
          o.t.landed = this.time;
          // 스테이션 → 문 앞 인계(단지 배송원 대기열)는 M6 에서 모델링. 지금은 착륙 즉시 완료로 처리
          o.status = 'DELIVERED';
          o.t.delivered = this.time;
          this.emit({ type: 'ORDER_DELIVERED', orderId: o.id });
        }
        break;
      }
      case 'RETURN_START':
        d.path = m.backPath;
        d.route = m.backRoute;
        this.setPhase(rt, 'RETURN');
        break;
      case 'ARRIVED_HOME':
        rt.mission = null;
        // 패드에서 격납고로
        d.position = clone(rt.slot);
        d.path = [];
        d.route = null;
        d.orderId = null;
        d.cruiseAltM = null;
        this.setPhase(rt, 'IDLE');
        if (d.battery < this.config.drone.swapBelowBattery) d.swapUntil = this.time + this.config.drone.batterySwapSec;
        break;
    }

    if (rt.mission && isAirborneStage(pr.stage)) {
      const offsets = pr.stage === 'OUTBOUND' ? m.outOffsets : m.backOffsets;
      d.pathIndex = offsets[Math.min(pr.legIndex, offsets.length - 1)] + pr.wpIndex;
    }
    if (AIRBORNE.has(d.phase)) {
      d.battery = drainBattery(d.battery, dt, this.config, this.wind.meanSpeed);
      const hs = Math.hypot(d.velocity.x, d.velocity.y);
      // 방위각: 북 = 0, 시계 방향
      if (hs > 0.3) d.headingRad = Math.atan2(d.velocity.x, d.velocity.y);
    }
  }

  private checkSeparation() {
    const airborne = this.drones.filter((d) => AIRBORNE.has(d.phase));
    const pairs = findSeparationViolations(airborne, this.config.traffic.minSeparationM);
    if (pairs.length === 0 && this.activePairs.size === 0) return;
    const next = new Map<string, SimEvent>();
    for (const p of pairs) {
      const key = `${p.a}|${p.b}`;
      const ev: SimEvent = { type: 'SEPARATION_VIOLATION', droneIds: [p.a, p.b], distM: p.distM, t: this.time };
      next.set(key, ev);
      if (!this.activePairs.has(key)) {
        this.violationEvents++;
        this.emit(ev);
      }
    }
    this.activePairs = next;
    this.alerts = [...next.values()];
  }

  // ── 주문·배정 ──

  private nextArrivalSteps(perMin: number): number {
    return Math.max(1, Math.round(this.rng.exp(60 / perMin) / this.dt));
  }

  private createOrder(storeId?: string, destBuildingId?: string): DispatchResult {
    const store = storeId ? this.map.stores.find((s) => s.id === storeId) : this.rng.pick(this.map.stores);
    if (!store) return { ok: false, reason: `없는 가게: ${storeId}` };
    const apartments = this.map.buildings.filter((b) => b.kind === 'APARTMENT');
    const dest = destBuildingId ? apartments.find((b) => b.id === destBuildingId) : this.rng.pick(apartments);
    if (!dest) return { ok: false, reason: `없는 아파트 동: ${destBuildingId}` };
    const station = this.map.stations.find((s) => s.servesBuildingIds.includes(dest.id));
    if (!station) return { ok: false, reason: `${dest.id} 를 담당하는 스테이션이 없습니다` };

    const { weightMinKg, weightMaxKg } = this.config.orders;
    const id = `O${String(++this.orderSeq).padStart(4, '0')}`;
    const order: Order = {
      id,
      storeId: store.id,
      stationId: station.id,
      destBuildingId: dest.id,
      weightKg: Math.round(this.rng.range(weightMinKg, weightMaxKg) * 10) / 10,
      mode: 'DRONE',
      status: 'WAITING_DRONE',
      droneId: null,
      // 조리·도크 이동 시간은 M6 에서 모델링. 지금은 주문 즉시 도크에 도착한 것으로 처리
      t: { created: this.time, cookDone: this.time, atDock: this.time },
    };
    this.orders.push(order);
    this.ordersById.set(id, order);
    this.queue.push(id);
    return { ok: true, orderId: id };
  }

  private runDispatcher() {
    if (this.queue.length === 0) return;
    const remaining: string[] = [];
    for (const orderId of this.queue) {
      const o = this.ordersById.get(orderId)!;
      if ((this.retryAt.get(orderId) ?? 0) > this.stepCount) {
        remaining.push(orderId);
        continue;
      }
      const store = this.map.stores.find((s) => s.id === o.storeId)!;
      const candidates = this.runtimes
        .filter((r) => !r.mission && r.drone.swapUntil === null && r.drone.homeDockId === store.dockId)
        .sort((a, b) => b.drone.battery - a.drone.battery);
      let assigned = false;
      for (const rt of candidates) {
        const res = this.schedule(rt, o.stationId, o.id, o.weightKg);
        if (res.ok) {
          o.droneId = rt.drone.id;
          o.t.assigned = this.time;
          assigned = true;
          break;
        }
        if (res.reason === 'battery') {
          // 이 임무를 하기엔 배터리가 부족하다: 교체하고 다음 드론을 본다
          rt.drone.swapUntil = this.time + this.config.drone.batterySwapSec;
          continue;
        }
        // 교통 혼잡이나 경로 문제는 같은 도크의 다른 드론도 거의 같으므로 잠시 후 다시 시도
        this.retryAt.set(orderId, this.stepCount + Math.round(this.config.traffic.retryAfterSec / this.dt));
        break;
      }
      if (assigned) this.retryAt.delete(orderId);
      else remaining.push(orderId);
    }
    this.queue = remaining;
  }

  private flyMission(cmd: Extract<SimCommand, { type: 'FLY_MISSION' }>): DispatchResult {
    const dock = this.docks.get(cmd.fromDockId);
    if (!dock) return { ok: false, reason: `없는 도크: ${cmd.fromDockId}` };
    if (!this.stations.has(cmd.toStationId)) return { ok: false, reason: `없는 스테이션: ${cmd.toStationId}` };
    const payload = cmd.payloadKg ?? this.config.fleet.missionPayloadKg;
    if (payload > this.config.drone.maxPayloadKg) {
      return { ok: false, reason: `탑재 중량 ${payload}kg 이 최대 ${this.config.drone.maxPayloadKg}kg 을 넘습니다` };
    }
    const rt = cmd.droneId
      ? this.byId.get(cmd.droneId)
      : this.runtimes
          .filter((r) => !r.mission && r.drone.swapUntil === null && r.drone.homeDockId === dock.id)
          .sort((a, b) => b.drone.battery - a.drone.battery)[0];
    if (!rt) return { ok: false, reason: `${dock.name ?? dock.id} 에 대기 중인 드론이 없습니다` };
    if (rt.mission) return { ok: false, reason: `${rt.drone.id} 는 이미 임무 중입니다` };
    if (rt.drone.homeDockId !== dock.id) return { ok: false, reason: `${rt.drone.id} 는 ${dock.id} 소속이 아닙니다` };
    const res = this.schedule(rt, cmd.toStationId, null, payload);
    return res.ok ? { ok: true, droneId: rt.drone.id } : { ok: false, reason: res.detail };
  }

  /** 예약 테이블·패드·배터리를 모두 만족하는 가장 이른 출발을 찾아 임무를 확정한다 */
  private schedule(rt: DroneRuntime, stationId: string, orderId: string | null, payloadKg: number): ScheduleResult {
    const station = this.stations.get(stationId)!;
    const pads = this.pads.get(stationId)!;
    const dockId = rt.drone.homeDockId;
    const dPads = this.dockPads.get(dockId)!;
    const t = this.config.traffic;
    const dwellSteps = Math.round(this.config.drone.stationDwellSec / this.dt);
    const baseSlot = Math.floor(this.stepCount / this.stepsPerSlot) + 1;
    const delaySlots: number[] = [];
    const maxDelay = this.useReservations ? t.maxDepartureDelaySec : 0;
    for (let s = 0; s <= maxDelay + 1e-9; s += t.delayStepSec) delaySlots.push(Math.round(s / t.slotSec));
    const cruise = this.config.altitude.cruiseM;
    const alts: readonly (readonly [number, number])[] = this.useReservations ? t.altitudePairsM : [[cruise, cruise]];

    // (고도, 패드) 조합별 예측은 출발 지연과 무관하다 (시간만 평행 이동)
    // 예측은 (도크 패드, 스테이션 패드, 고도) 로 정해지므로 모든 드론이 공유한다
    const candidate = (alt: readonly [number, number], dp: number, padIndex: number) => {
      const key = `${dockId}#${dp}|${stationId}#${padIndex}@${alt[0]}/${alt[1]}`;
      if (!this.candidateCache.has(key)) {
        this.candidateCache.set(key, this.buildCandidate(dockId, dp, station, padIndex, alt[0], alt[1], dwellSteps));
      }
      return this.candidateCache.get(key)!;
    };

    const rate = (1 + this.config.drone.batteryWindFactorPerMs * this.wind.meanSpeed) / this.config.drone.enduranceSec;
    let sawRoute = false;
    let batteryShort = false;
    for (const delay of delaySlots) {
      const departSlot = baseSlot + delay;
      const departStep = departSlot * this.stepsPerSlot;
      for (const alt of alts) {
        for (let dp = 0; dp < dPads.length; dp++) {
          for (let p = 0; p < pads.length; p++) {
          const c = candidate(alt, dp, p);
          if (!c) continue;
          sawRoute = true;
          const need = c.pred.airborneSteps * this.dt * rate * this.config.drone.batterySafetyFactor + this.config.drone.batteryReserve;
          if (rt.drone.battery < need) {
            batteryShort = true;
            continue;
          }
          const from = departStep + c.pred.landedStep;
          const to = departStep + c.pred.returnStartStep;
          if (this.padOverlaps(stationId, p, from, to)) continue;
          // 도크 패드: 출발 직전 1칸, 복귀 착륙 직후 1칸 동안 비어 있어야 한다
          const dkey = `${dockId}#d${dp}`;
          const done = departStep + c.pred.doneStep;
          if (this.padKeyOverlaps(dkey, departStep - this.stepsPerSlot, departStep)) continue;
          if (this.padKeyOverlaps(dkey, done, done + this.stepsPerSlot)) continue;
          if (this.useReservations && !this.table.isFree(rt.drone.id, departSlot, c.pred.footprint)) continue;

          this.commit(rt, c, departStep, departSlot, stationId, orderId, payloadKg, from, to);
          this.addBusy(dkey, departStep - this.stepsPerSlot, departStep);
          this.addBusy(dkey, done, done + this.stepsPerSlot);
          this.trafficDelaySumSec += delay * t.slotSec;
          if (alt[0] !== cruise) this.altitudeShifted++;
          return { ok: true };
          }
        }
      }
    }
    if (!sawRoute) return { ok: false, reason: 'route', detail: `${station.name ?? station.id} 까지 경로가 없습니다` };
    if (batteryShort) return { ok: false, reason: 'battery', detail: `${rt.drone.id} 배터리 부족` };
    return { ok: false, reason: 'traffic', detail: '혼잡: 예약 가능한 출발 시각이 없습니다' };
  }

  private buildCandidate(
    dockId: string,
    dockPadIndex: number,
    station: Station,
    padIndex: number,
    outAlt: number,
    backAlt: number,
    dwellSteps: number,
  ): Candidate | null {
    const dockCenter = this.docks.get(dockId)!.position;
    const dockPad = this.dockPads.get(dockId)![dockPadIndex];
    const pad = this.pads.get(station.id)![padIndex];
    const out = this.planAnchored(dockPad, dockCenter, pad, station.position, outAlt);
    const back = this.planAnchored(pad, station.position, dockPad, dockCenter, backAlt);
    if (!out.ok || !back.ok) return null;
    const outLegs: Leg[] = buildTripLegs(dockPad, pad, outAlt, out.path.slice(1, -1));
    const backLegs: Leg[] = buildTripLegs(pad, dockPad, backAlt, back.path.slice(1, -1));
    const legs = { out: outLegs, back: backLegs, dwellSteps };
    const pred = predictMission(legs, dockPad, this.limits, this.dt, this.stepsPerSlot, this.table);
    const o = flattenLegs(outLegs);
    const b = flattenLegs(backLegs);
    return {
      legs,
      pred,
      outPath: o.path,
      outOffsets: o.offsets,
      backPath: b.path,
      backOffsets: b.offsets,
      outRoute: routeInfo(out),
      backRoute: routeInfo(back),
      outAlt,
      backAlt,
      padIndex,
      dockPadIndex,
      dockPad,
    };
  }

  private commit(
    rt: DroneRuntime,
    c: Candidate,
    departStep: number,
    departSlot: number,
    stationId: string,
    orderId: string | null,
    payloadKg: number,
    padFrom: number,
    padTo: number,
  ) {
    // 예약 테이블을 꺼도 예약은 기록한다 (다시 켰을 때 새 임무가 기존 비행을 피하도록)
    this.table.reserve(rt.drone.id, departSlot, c.pred.footprint);
    this.addBusy(`${stationId}#${c.padIndex}`, padFrom, padTo);

    rt.mission = {
      orderId,
      stationId,
      padIndex: c.padIndex,
      dockPad: c.dockPad,
      legs: { ...c.legs, departStep },
      progress: newProgress(),
      outPath: c.outPath,
      outOffsets: c.outOffsets,
      backPath: c.backPath,
      backOffsets: c.backOffsets,
      outRoute: c.outRoute,
      backRoute: c.backRoute,
      cruiseAltM: c.outAlt,
    };
    const d = rt.drone;
    d.departAt = departStep * this.dt;
    d.orderId = orderId;
    d.payloadKg = payloadKg;
    d.cruiseAltM = c.outAlt;
    d.pathIndex = 0;
    this.missionsScheduled++;
  }

  private padOverlaps(stationId: string, pad: number, from: number, to: number): boolean {
    return this.padKeyOverlaps(`${stationId}#${pad}`, from, to);
  }

  private addBusy(key: string, from: number, to: number) {
    if (!this.padBusy.has(key)) this.padBusy.set(key, []);
    this.padBusy.get(key)!.push({ from, to });
  }

  private padKeyOverlaps(key: string, from: number, to: number): boolean {
    const busy = this.padBusy.get(key);
    // 같은 스텝에 떠나고 들어오는 것도 막기 위해 끝점을 포함해 비교한다
    return !!busy?.some((b) => from <= b.to + 1 && b.from <= to + 1);
  }

  /**
   * 도크 중심 ↔ 스테이션 중심 경로를 한 번 계획해 두고, 양 끝만 슬롯·패드로 바꿔 쓴다.
   * (슬롯·패드마다 A* 를 새로 돌리면 드론 수 × 패드 수 × 고도 수만큼 탐색해야 한다)
   */
  private planAnchored(from: Vec3, fromAnchor: Vec3, to: Vec3, toAnchor: Vec3, z: number): PlanResult {
    const base = this.planCruise(fromAnchor, toAnchor, z);
    if (base.ok) {
      const r = this.planner.reanchor(base, { x: from.x, y: from.y, z }, { x: to.x, y: to.y, z });
      if (r) return r;
    }
    return this.planCruise(from, to, z);
  }

  private planCruise(from: Vec3, to: Vec3, z: number): PlanResult {
    const key = `${from.x},${from.y}>${to.x},${to.y}@${z}`;
    let r = this.routeCache.get(key);
    if (!r) {
      r = this.planner.plan({ x: from.x, y: from.y, z }, { x: to.x, y: to.y, z });
      this.routeCache.set(key, r);
    }
    return r;
  }

  private prune() {
    const slot = Math.floor(this.stepCount / this.stepsPerSlot);
    this.table.prune(slot);
    for (const [k, list] of this.padBusy) {
      const kept = list.filter((b) => b.to >= this.stepCount);
      if (kept.length) this.padBusy.set(k, kept);
      else this.padBusy.delete(k);
    }
  }

  // ── 공통 ──

  private trafficStats(): TrafficStats {
    return {
      reservationsEnabled: this.useReservations,
      activeViolations: this.activePairs.size,
      violationEvents: this.violationEvents,
      reservedCells: this.table?.size ?? 0,
      missionsScheduled: this.missionsScheduled,
      avgTrafficDelaySec: this.missionsScheduled ? this.trafficDelaySumSec / this.missionsScheduled : 0,
      altitudeShiftRatio: this.missionsScheduled ? this.altitudeShifted / this.missionsScheduled : 0,
      queuedOrders: this.queue.length,
    };
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
}

function routeInfo(p: Extract<PlanResult, { ok: true }>): RouteInfo {
  const a = p.path[0];
  const b = p.path[p.path.length - 1];
  return {
    rawPath: p.rawPath,
    lengthM: p.lengthM,
    straightM: Math.hypot(b.x - a.x, b.y - a.y),
    estCruiseSec: p.estFlightSec,
    expandedNodes: p.expanded,
    computeMs: p.computeMs,
  };
}
