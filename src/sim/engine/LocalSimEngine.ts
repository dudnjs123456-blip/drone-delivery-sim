/**
 * 자체 단순 물리 엔진 (다중 드론 + 돌발 상황).
 *
 * 비행 단계: IDLE ─(배정·출발 시각)→ TAKEOFF → CRUISE → DESCEND → LANDED ─(하역)→ RETURN → IDLE
 *            돌발 상황: 어느 비행 단계에서든 HOLD(공중 대기) 로 들어갔다가 재개·복귀할 수 있고,
 *            추락·비상착륙하면 FAILED(회수 전까지 운용 불가).
 *
 * 배정(dispatch)
 * - 1초(예약 시간 칸)마다 대기 주문을 FIFO 로 처리한다. 가게의 도크에 있는 대기 드론 중 배터리가 많은 순.
 * - 후보 (출발 지연 × 방향별 고도 × 도크 패드 × 스테이션 패드) 마다 왕복 궤적을 stepMission 으로 예측하고,
 *   예약 테이블·패드 점유와 겹치지 않는 첫 후보를 확정한다.
 * - 돌발 상황으로 경로·대기가 바뀌면 남은 궤적을 다시 예측해 예약을 갱신한다 (충돌 확인 없이: 비상 우선).
 *
 * 돌발 상황 인지 경로
 * - UTM 방송(임시 비행금지구역, 스테이션 폐쇄, ADS-B 침입기): 통신이 살아 있는 드론만 즉시 안다.
 * - 기체 센서(미등록 장애물, ADS-B 없는 침입기): 탐지 거리 안에 들어와야 안다. 장애물은 탐지되면 UTM 으로 공유.
 */
import type { SimConfig } from '../config';
import { drainBattery } from '../flight/battery';
import { type MotionLimits, limitsFromConfig, stepAlongPath } from '../flight/kinematics';
import { type MissionLegs, type MissionProgress, isAirborneStage, newProgress, stepMission } from '../flight/mission';
import { type Leg, buildTripLegs, flattenLegs } from '../flight/route';
import {
  insideObstacle,
  insideTfr,
  intruderPosition,
  intruderVelocity,
  obstacleAsBuilding,
  obstacleDistance,
  pathHitsHazard,
  tfrAsZone,
} from '../hazards/geometry';
import {
  type HazardLogEntry,
  type HazardLogSeverity,
  type HazardSettings,
  type HazardSpec,
  type HazardState,
  type ResponsePolicies,
  type SafetyStats,
  defaultPolicies,
  emptySafety,
} from '../hazards/types';
import { dockLaunchPads, dockParking, stationPads } from '../map/pads';
import { type KitchenState, type RunnerState, kitchenProfile } from '../orders/firstMile';
import { distanceToPolygon } from '../pathfinding/obstacles';
import { type PlanResult, PathPlanner } from '../pathfinding/planner';
import { type MissionPrediction, predictMission, predictRemaining } from '../traffic/predict';
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
const HAZARD_LOG_LIMIT = 300;
/** 예약 테이블에서 지난 칸을 지우는 주기 (s) */
const PRUNE_EVERY_SEC = 30;
/** 침입기가 지도 밖으로 이만큼 벗어나면 사라진 것으로 본다 (m) */
const INTRUDER_EXIT_MARGIN_M = 300;

type HoldReason = 'INTRUDER' | 'OBSTACLE' | 'LINK' | 'STATION';

interface Hold {
  point: Vec3;
  untilStep: number;
  reason: HoldReason;
  hazardId?: string;
  onEnd: 'RESUME' | 'RTH';
  /** 대기가 끝나면 돌아갈 비행 단계 */
  resumePhase: FlightPhase;
}

interface Mission {
  orderId: string | null;
  stationId: string;
  padIndex: number;
  /** 출발·복귀하는 도크 패드 */
  dockPad: Vec3;
  dockPadKey: string;
  legs: MissionLegs;
  progress: MissionProgress;
  outPath: Vec3[];
  outOffsets: number[];
  backPath: Vec3[];
  backOffsets: number[];
  outRoute: RouteInfo;
  backRoute: RouteInfo;
  outAlt: number;
  backAlt: number;
  hold: Hold | null;
  /** 비상착륙 중이면 착륙할 패드 (홈 도크 패드가 아니면 착륙 후 FAILED) */
  emergencyPad: Vec3 | null;
  /** 패드에서 화물 적재를 시작하는 스텝 (= 출발 스텝 - 적재 시간) */
  loadStartStep: number;
  loading: boolean;
  payloadKg: number;
}

interface DroneRuntime {
  drone: Drone;
  /** 홈 도크 격납고 칸 (대기 위치) */
  slot: Vec3;
  mission: Mission | null;
  linkLostUntilStep: number | null;
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

const AIRBORNE: ReadonlySet<FlightPhase> = new Set(['TAKEOFF', 'CRUISE', 'DESCEND', 'RETURN', 'HOLD']);

const holdLabel: Record<HoldReason, string> = {
  INTRUDER: '대기: 침입기 회피',
  OBSTACLE: '대기: 장애물 탐지',
  LINK: '대기: 통신두절',
  STATION: '대기: 스테이션 폐쇄',
};

export class LocalSimEngine implements SimEngine {
  private map!: MapData;
  private config!: SimConfig;
  private seed = 0;
  private dt = 0.05;
  private limits!: MotionLimits;
  /** 돌발 장애물이 없을 때의 계획기 (격자 생성이 비싸서 재사용) */
  private basePlanner!: PathPlanner;
  private planner!: PathPlanner;
  private plannerKey: { map: MapData; config: SimConfig } | null = null;
  private routeCache = new Map<string, PlanResult>();
  /** (도크 패드, 스테이션 패드, 고도) → 왕복 궤적 예측. 결정적이라 재사용한다 */
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
  /** 패드 키 → 점유 구간 [from, to] (스텝) */
  private padBusy = new Map<string, { from: number; to: number; owner: string }[]>();
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

  // 돌발 상황
  private hazards: HazardState[] = [];
  private hazardSeq = 0;
  private hazardLog: HazardLogEntry[] = [];
  private safety: SafetyStats = emptySafety();
  private policies: ResponsePolicies = { ...defaultPolicies };
  private hazardSettings!: HazardSettings;
  private tfrInside = new Set<string>();
  private nearMissActive = new Set<string>();
  /** stationId → 폐쇄 hazardId */
  private closedStations = new Map<string, string>();

  // 퍼스트 마일
  private kitchens: KitchenState[] = [];
  private kitchenByStore = new Map<string, KitchenState>();
  private runners: RunnerState[] = [];
  private firstMileScale: number | undefined;

  private listeners = new Set<(e: SimEvent) => void>();
  private snapshot!: SimSnapshot;

  load(map: MapData, config: SimConfig, seed: number): void {
    this.map = map;
    this.config = config;
    this.seed = seed;
    this.dt = config.time.fixedDtSec;
    this.limits = limitsFromConfig(config);
    if (!this.plannerKey || this.plannerKey.map !== map || this.plannerKey.config !== config) {
      this.basePlanner = new PathPlanner(map, config);
      this.plannerKey = { map, config };
    }
    this.planner = this.basePlanner;
    this.routeCache.clear();
    this.candidateCache.clear();
    this.stepsPerSlot = Math.round(config.traffic.slotSec / this.dt);
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

    this.hazards = [];
    this.hazardSeq = 0;
    this.hazardLog = [];
    this.safety = emptySafety();
    this.tfrInside.clear();
    this.nearMissActive.clear();
    this.closedStations.clear();
    const hz = config.hazards;
    this.hazardSettings ??= {
      sensorRangeM: hz.sensorRangeM,
      adsbAlertRangeM: hz.adsbAlertRangeM,
      intruderClearRangeM: hz.intruderClearRangeM,
      linkLossHoldSec: hz.linkLossHoldSec,
    };

    this.firstMileScale ??= config.kitchen.timeScale;
    this.kitchens = map.stores.map((st) => ({ storeId: st.id, dockId: st.dockId, queue: [], cooking: [], packQueue: [], packing: [], ready: [] }));
    this.kitchenByStore = new Map(this.kitchens.map((k) => [k.storeId, k]));
    this.runners = [];
    for (const st of map.stores) {
      const n = kitchenProfile(config, st.id).runners;
      for (let i = 0; i < n; i++) {
        this.runners.push({ id: `${st.id}#${i + 1}`, storeId: st.id, dockId: st.dockId, phase: 'IDLE', orderIds: [], startStep: 0, endStep: 0 });
      }
    }

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
        alert: null,
        linkLostUntil: null,
      };
      this.runtimes.push({ drone, slot, mission: null, linkLostUntilStep: null });
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
      hazards: this.hazards,
      hazardLog: this.hazardLog,
      safety: this.safety,
      policies: this.policies,
      hazardSettings: this.hazardSettings,
      kitchens: this.kitchens,
      runners: this.runners,
      firstMileScale: this.firstMileScale,
    };
  }

  /** 주문·드론·돌발 상황을 처음 상태로 (대응 정책과 센서 설정은 유지) */
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
    s.policies = this.policies;
    s.hazardSettings = this.hazardSettings;
    s.firstMileScale = this.firstMileScale!;
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
      case 'INJECT_HAZARD':
        return this.injectHazard(cmd.spec, cmd.atSec);
      case 'CANCEL_HAZARD': {
        const h = this.hazards.find((x) => x.id === cmd.hazardId);
        if (!h) return { ok: false, reason: `없는 돌발 상황: ${cmd.hazardId}` };
        if (h.status === 'SCHEDULED') h.status = 'CANCELLED';
        else if (h.status === 'ACTIVE') this.endHazard(h, '사용자가 종료');
        return { ok: true };
      }
      case 'SET_POLICIES':
        this.policies = { ...this.policies, ...cmd.policies };
        return { ok: true };
      case 'SET_FIRST_MILE_SCALE':
        this.firstMileScale = Math.max(0, cmd.scale);
        return { ok: true };
      case 'SET_HAZARD_SETTINGS':
        this.hazardSettings = { ...this.hazardSettings, ...cmd.settings };
        return { ok: true };
      case 'SET_WIND':
        // M5 에서 구현
        return { ok: false, reason: 'SET_WIND 는 아직 구현되지 않았습니다' };
    }
  }

  step(dt: number): void {
    this.stepCount++;
    const step = this.stepCount;

    this.processHazardTimeline();
    this.processKitchens(step);

    if (this.peak && step >= this.peak.nextStep) {
      this.createOrder();
      this.peak.nextStep = step + this.nextArrivalSteps(this.peak.perMin);
    }

    for (const rt of this.runtimes) this.stepDrone(rt, step, dt);
    this.safetyChecks();
    this.checkSeparation();

    if (step % this.stepsPerSlot === 0) this.runDispatcher();
    if (step % Math.round(PRUNE_EVERY_SEC / this.dt) === 0) this.prune();
  }

  // ── 드론 진행 ──

  private stepDrone(rt: DroneRuntime, step: number, dt: number) {
    const d = rt.drone;
    if (d.phase === 'FAILED') return;
    const m = rt.mission;
    if (!m) {
      if (d.swapUntil !== null && this.time >= d.swapUntil - 1e-9) {
        d.battery = 1;
        d.swapUntil = null;
      }
      return;
    }

    if (m.hold) {
      if (step >= m.hold.untilStep) {
        this.endHold(rt, m.hold.onEnd);
      } else {
        stepAlongPath(d, [m.hold.point, m.hold.point], 1, this.limits, dt);
        this.afterMove(rt, dt);
        return;
      }
      if (!rt.mission) return;
    }

    // 적재 시작: 격납고에서 이착륙 패드로 옮겨 화물을 싣는다 (지상이므로 공역 예약은 없다)
    if (m.progress.stage === 'SCHEDULED' && !m.loading && step >= m.loadStartStep) this.startLoading(rt);
    const ev = stepMission(m.legs, m.progress, d, step, this.limits, dt);
    const pr = m.progress;
    switch (ev) {
      case 'DEPART': {
        if (!m.loading) this.startLoading(rt);
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
        if (d.alert && !d.linkLostUntil) d.alert = null;
        this.setPhase(rt, 'LANDED');
        if (this.closedStations.has(m.stationId)) {
          this.safety.closedLandings++;
          this.log('bad', `폐쇄된 ${this.stationName(m.stationId)}에 착륙 (지상 인원 위험)`, this.closedStations.get(m.stationId), d.id);
        }
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
        this.arriveHome(rt);
        return;
    }

    if (rt.mission && isAirborneStage(pr.stage)) {
      const offsets = pr.stage === 'OUTBOUND' ? m.outOffsets : m.backOffsets;
      d.pathIndex = offsets[Math.min(pr.legIndex, offsets.length - 1)] + pr.wpIndex;
    }
    this.afterMove(rt, dt);
  }

  private afterMove(rt: DroneRuntime, dt: number) {
    const d = rt.drone;
    if (!AIRBORNE.has(d.phase)) return;
    d.battery = drainBattery(d.battery, dt, this.config, this.wind.meanSpeed);
    const hs = Math.hypot(d.velocity.x, d.velocity.y);
    // 방위각: 북 = 0, 시계 방향
    if (hs > 0.3) d.headingRad = Math.atan2(d.velocity.x, d.velocity.y);
    if (d.battery <= 0) this.crash(rt, '배터리 방전');
  }

  private arriveHome(rt: DroneRuntime) {
    const d = rt.drone;
    const m = rt.mission!;
    const home = this.dockPads.get(d.homeDockId)!;
    const atHome = !m.emergencyPad || home.some((p) => p.x === m.emergencyPad!.x && p.y === m.emergencyPad!.y);
    rt.mission = null;
    d.path = [];
    d.route = null;
    d.orderId = null;
    d.cruiseAltM = null;
    d.velocity = { x: 0, y: 0, z: 0 };
    if (!atHome) {
      // 다른 곳에 비상착륙: 회수 전까지 운용 불가
      this.table.release(d.id, 0);
      this.releaseBusy(d.id);
      d.alert = '비상착륙 (회수 필요)';
      this.setPhase(rt, 'FAILED');
      this.log('warn', `${d.id} 비상착륙 완료 — 회수 필요`, undefined, d.id);
      return;
    }
    // 패드에서 격납고로
    d.position = clone(rt.slot);
    if (!d.linkLostUntil) d.alert = null;
    this.setPhase(rt, 'IDLE');
    if (d.battery < this.config.drone.swapBelowBattery) d.swapUntil = this.time + this.config.drone.batterySwapSec;
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

  // ── 돌발 상황: 주입·타임라인 ──

  private injectHazard(spec: HazardSpec, atSec?: number): DispatchResult {
    const err = this.validateHazard(spec);
    if (err) return { ok: false, reason: err };
    const id = `H${String(++this.hazardSeq).padStart(2, '0')}`;
    const at = atSec === undefined ? this.time : Math.max(this.time, atSec);
    this.hazards.push({ id, spec, at, status: 'SCHEDULED' });
    if (at > this.time + 1e-9) this.log('info', `${hazardName(spec)} 예약 (T=${at.toFixed(0)}s)`, id);
    return { ok: true, hazardId: id };
  }

  private validateHazard(spec: HazardSpec): string | null {
    switch (spec.kind) {
      case 'TFR':
        return spec.radiusM > 0 ? null : '반경은 0보다 커야 합니다';
      case 'OBSTACLE':
        return spec.sizeM > 0 && spec.heightM > 0 ? null : '크기·높이는 0보다 커야 합니다';
      case 'INTRUDER':
        return spec.speedMs > 0 ? null : '속도는 0보다 커야 합니다';
      case 'BATTERY_DROP':
        if (spec.droneId && !this.byId.has(spec.droneId)) return `없는 드론: ${spec.droneId}`;
        return spec.toPercent >= 0 && spec.toPercent <= 100 ? null : '잔량은 0~100% 입니다';
      case 'LINK_LOSS':
        if (spec.droneId && !this.byId.has(spec.droneId)) return `없는 드론: ${spec.droneId}`;
        return spec.durationSec > 0 ? null : '지속 시간은 0보다 커야 합니다';
      case 'STATION_CLOSED':
        return this.stations.has(spec.stationId) ? null : `없는 스테이션: ${spec.stationId}`;
    }
  }

  private hazardEnd(h: HazardState): number | null {
    const s = h.spec;
    switch (s.kind) {
      case 'TFR':
        return s.durationSec ? h.at + s.durationSec : null;
      case 'OBSTACLE':
        return null;
      case 'INTRUDER':
      case 'LINK_LOSS':
      case 'STATION_CLOSED':
        return h.at + s.durationSec;
      case 'BATTERY_DROP':
        return h.at;
    }
  }

  private processHazardTimeline() {
    for (const h of this.hazards) {
      if (h.status === 'SCHEDULED' && this.time >= h.at - 1e-9) this.activateHazard(h);
      if (h.status === 'ACTIVE') {
        const end = this.hazardEnd(h);
        if (end !== null && this.time >= end - 1e-9 && h.spec.kind !== 'BATTERY_DROP') this.endHazard(h, '지속 시간 종료');
        if (h.spec.kind === 'INTRUDER') {
          const p = intruderPosition(h.spec, this.time - h.at);
          h.position = p;
          const b = this.map.bounds;
          const m = INTRUDER_EXIT_MARGIN_M;
          if (p.x < b.minX - m || p.x > b.maxX + m || p.y < b.minY - m || p.y > b.maxY + m) this.endHazard(h, '구역 이탈');
        }
      }
    }
  }

  private activateHazard(h: HazardState) {
    h.status = 'ACTIVE';
    const s = h.spec;
    switch (s.kind) {
      case 'TFR':
        this.log('warn', `임시 비행금지구역 발령 (반경 ${s.radiusM}m) — UTM 방송`, h.id);
        this.rebuildPlanner();
        this.respondToAirspaceHazard(h, null);
        break;
      case 'OBSTACLE':
        h.discovered = false;
        this.log('warn', `미등록 장애물 출현 (높이 ${s.heightM}m) — UTM 은 모름, 센서 탐지 필요`, h.id);
        break;
      case 'INTRUDER':
        h.position = intruderPosition(s, 0);
        this.log('warn', `비협조 비행체 진입 (${s.altitudeM}m, ${s.speedMs}m/s, ADS-B ${s.adsb ? '있음' : '없음'})`, h.id);
        break;
      case 'BATTERY_DROP': {
        const rt = this.pickTarget(s.droneId);
        h.status = 'ENDED';
        h.endedAt = this.time;
        if (!rt) {
          this.log('info', '배터리 급감: 대상 드론이 없습니다', h.id);
          return;
        }
        h.targetDroneId = rt.drone.id;
        rt.drone.battery = Math.min(rt.drone.battery, s.toPercent / 100);
        this.log('bad', `${rt.drone.id} 배터리 급감 → ${s.toPercent}%`, h.id, rt.drone.id);
        if (!rt.mission || !AIRBORNE.has(rt.drone.phase)) return;
        const p = this.policies.BATTERY_DROP;
        if (p === 'RTH') this.returnHome(rt, '배터리 급감');
        else if (p === 'NEAREST') this.emergencyLandNearest(rt, '배터리 급감');
        else this.log('info', `${rt.drone.id} 대응 없음 — 비행 계속`, h.id, rt.drone.id);
        break;
      }
      case 'LINK_LOSS': {
        const rt = this.pickTarget(s.droneId);
        if (!rt) {
          h.status = 'ENDED';
          h.endedAt = this.time;
          this.log('info', '통신 두절: 대상 드론이 없습니다', h.id);
          return;
        }
        h.targetDroneId = rt.drone.id;
        rt.linkLostUntilStep = this.stepCount + Math.round(s.durationSec / this.dt);
        rt.drone.linkLostUntil = this.time + s.durationSec;
        rt.drone.alert = '통신두절';
        this.log('bad', `${rt.drone.id} 통신 두절 (${s.durationSec}s) — UTM 지시 수신 불가`, h.id, rt.drone.id);
        if (!rt.mission || !AIRBORNE.has(rt.drone.phase)) return;
        const p = this.policies.LINK_LOSS;
        if (p === 'RTH') this.returnHome(rt, '통신두절');
        else if (p === 'HOLD_RTH') this.startHold(rt, clone(rt.drone.position), this.hazardSettings.linkLossHoldSec, 'LINK', 'RTH', h.id);
        else this.log('info', `${rt.drone.id} 자율 비행 계속`, h.id, rt.drone.id);
        break;
      }
      case 'STATION_CLOSED':
        this.closedStations.set(s.stationId, h.id);
        this.log('warn', `${this.stationName(s.stationId)} 폐쇄 (${s.durationSec}s)`, h.id);
        this.respondToStationClosure(h, s.stationId);
        break;
    }
  }

  private endHazard(h: HazardState, why: string) {
    h.status = 'ENDED';
    h.endedAt = this.time;
    const s = h.spec;
    this.log('info', `${hazardName(s)} 종료 (${why})`, h.id);
    switch (s.kind) {
      case 'TFR':
        this.rebuildPlanner();
        break;
      case 'OBSTACLE':
        if (h.discovered) this.rebuildPlanner();
        break;
      case 'INTRUDER':
        // 대기 중인 드론은 safetyChecks 에서 재개된다
        break;
      case 'LINK_LOSS': {
        const rt = h.targetDroneId ? this.byId.get(h.targetDroneId) : undefined;
        if (!rt) break;
        rt.linkLostUntilStep = null;
        rt.drone.linkLostUntil = null;
        if (rt.drone.alert === '통신두절' || rt.drone.alert === holdLabel.LINK) rt.drone.alert = null;
        this.log('good', `${rt.drone.id} 통신 복구`, h.id, rt.drone.id);
        // 통신이 돌아오면 대기를 풀고, 그동안 놓친 UTM 정보(비행금지·폐쇄)를 다시 확인한다
        if (rt.mission?.hold?.reason === 'LINK') this.endHold(rt, 'RESUME');
        for (const other of this.hazards) {
          if (other.status !== 'ACTIVE') continue;
          if (other.spec.kind === 'TFR' || (other.spec.kind === 'OBSTACLE' && other.discovered)) this.respondToAirspaceHazard(other, rt);
          if (other.spec.kind === 'STATION_CLOSED') this.respondToStationClosure(other, other.spec.stationId, rt);
        }
        break;
      }
      case 'STATION_CLOSED':
        this.closedStations.delete(s.stationId);
        for (const rt of this.runtimes) {
          if (rt.mission?.hold?.reason === 'STATION' && rt.mission.hold.hazardId === h.id) this.endHold(rt, 'RESUME');
        }
        break;
      case 'BATTERY_DROP':
        break;
    }
  }

  private pickTarget(droneId: string | null): DroneRuntime | undefined {
    if (droneId) return this.byId.get(droneId);
    const flying = this.runtimes.filter((r) => AIRBORNE.has(r.drone.phase) && r.drone.phase !== 'HOLD');
    return flying.length ? this.rng.pick(flying) : undefined;
  }

  private linkOk(rt: DroneRuntime): boolean {
    return rt.linkLostUntilStep === null;
  }

  /** 계획기를 현재 공역(기본 지도 + 활성 비행금지 + 탐지된 장애물)으로 다시 만든다 */
  private rebuildPlanner() {
    const zones = this.hazards
      .filter((h) => h.status === 'ACTIVE' && h.spec.kind === 'TFR')
      .map((h) => tfrAsZone(h.id, h.spec as Extract<HazardSpec, { kind: 'TFR' }>, this.config.altitude.maxM));
    const obstacles = this.hazards
      .filter((h) => h.status === 'ACTIVE' && h.spec.kind === 'OBSTACLE' && h.discovered)
      .map((h) => obstacleAsBuilding(h.id, h.spec as Extract<HazardSpec, { kind: 'OBSTACLE' }>));
    this.planner =
      zones.length || obstacles.length
        ? new PathPlanner(
            { ...this.map, noFlyZones: [...this.map.noFlyZones, ...zones], buildings: [...this.map.buildings, ...obstacles] },
            this.config,
          )
        : this.basePlanner;
    this.routeCache.clear();
    this.candidateCache.clear();
  }

  /** 비행금지구역·탐지된 장애물: 남은 경로가 걸리는 드론에 정책을 적용한다 (only: 특정 드론만) */
  private respondToAirspaceHazard(h: HazardState, only: DroneRuntime | null, discoverer?: string) {
    const s = h.spec;
    if (s.kind !== 'TFR' && s.kind !== 'OBSTACLE') return;
    const pf = this.config.pathfinding;
    const margin = s.kind === 'TFR' ? pf.noFlyMarginM : pf.buildingClearanceM;
    const hits = (path: readonly Vec3[]) => pathHitsHazard(path, s, margin, pf.verticalClearanceM);

    for (const rt of only ? [only] : this.runtimes) {
      const m = rt.mission;
      const d = rt.drone;
      if (!m || d.phase === 'FAILED') continue;
      if (!this.linkOk(rt) && d.id !== discoverer) {
        if (hits([d.position, ...d.path.slice(d.pathIndex)])) {
          this.log('bad', `${d.id} 통신두절로 ${hazardName(s)} 정보를 받지 못함`, h.id, d.id);
        }
        continue;
      }
      const stage = m.progress.stage;
      if (stage === 'SCHEDULED') {
        if (hits(m.outPath) || hits(m.backPath)) this.cancelScheduled(rt, `${hazardName(s)}로 경로 무효`);
        continue;
      }
      if (stage === 'DWELL') {
        if (hits(m.backPath)) this.replanBack(rt);
        continue;
      }
      const remaining = [clone(d.position), ...d.path.slice(d.pathIndex)];
      if (!hits(remaining)) {
        // 앞으로 갈 복귀 경로만 걸리면 조용히 다시 계획한다
        if (stage === 'OUTBOUND' && hits(m.backPath)) this.replanBack(rt);
        continue;
      }
      if (s.kind === 'TFR') {
        const p = this.policies.TFR;
        if (p === 'IGNORE') this.log('warn', `${d.id} 비행금지구역 경보 무시 — 경로 유지`, h.id, d.id);
        else if (p === 'RTH' && stage === 'OUTBOUND') this.returnHome(rt, '비행금지구역');
        else this.reroute(rt, '비행금지구역', h.id);
      } else {
        const p = this.policies.OBSTACLE;
        if (p === 'IGNORE') this.log('warn', `${d.id} 장애물 정보 무시 — 경로 유지`, h.id, d.id);
        else if (p === 'HOLD_RTH') this.startHold(rt, clone(d.position), this.config.hazards.obstacleHoldSec, 'OBSTACLE', 'RTH', h.id);
        else this.reroute(rt, '장애물 회피', h.id);
      }
    }
  }

  private respondToStationClosure(h: HazardState, stationId: string, only: DroneRuntime | null = null) {
    for (const rt of only ? [only] : this.runtimes) {
      const m = rt.mission;
      const d = rt.drone;
      if (!m || m.stationId !== stationId || d.phase === 'FAILED') continue;
      const stage = m.progress.stage;
      if (stage !== 'SCHEDULED' && stage !== 'OUTBOUND') continue;
      if (!this.linkOk(rt)) {
        this.log('bad', `${d.id} 통신두절로 스테이션 폐쇄를 모름`, h.id, d.id);
        continue;
      }
      if (stage === 'SCHEDULED') {
        this.cancelScheduled(rt, '스테이션 폐쇄');
        continue;
      }
      const p = this.policies.STATION_CLOSED;
      if (p === 'DIVERT') this.divert(rt, h.id);
      else if (p === 'RTH') this.returnHome(rt, '스테이션 폐쇄');
      else {
        const end = this.hazardEnd(h) ?? this.time + 60;
        this.startHold(rt, clone(d.position), Math.max(1, end - this.time), 'STATION', 'RESUME', h.id);
      }
    }
  }

  /** 매 스텝: 충돌·근접·침범·센서 탐지와 침입기 대응 */
  private safetyChecks() {
    const hz = this.config.hazards;
    const set = this.hazardSettings;
    const active = this.hazards.filter((h) => h.status === 'ACTIVE');
    for (const rt of this.runtimes) {
      const d = rt.drone;
      if (!AIRBORNE.has(d.phase)) continue;
      const p = d.position;

      // 기존 건물 (정상이라면 일어나지 않는다)
      for (const b of this.map.buildings) {
        if (p.z < b.heightM - 0.05 && distanceToPolygon(p.x, p.y, b.footprint) === 0) {
          this.crash(rt, `${b.name ?? b.id} 충돌`);
          break;
        }
      }
      if (d.phase === 'FAILED') continue;

      for (const h of active) {
        if (isFailed(d)) break;
        const s = h.spec;
        if (s.kind === 'OBSTACLE') {
          if (insideObstacle(p, s)) {
            this.crash(rt, '미등록 장애물 충돌', h.id);
            break;
          }
          if (!h.discovered && obstacleDistance(p, s, this.config.pathfinding.verticalClearanceM) < set.sensorRangeM) {
            h.discovered = true;
            h.discoveredBy = d.id;
            const dist = obstacleDistance(p, s, Infinity);
            this.log('warn', `${d.id} 센서가 미등록 장애물 탐지 (거리 ${dist.toFixed(0)}m) → UTM 공유`, h.id, d.id);
            this.rebuildPlanner();
            this.respondToAirspaceHazard(h, null, d.id);
          }
        } else if (s.kind === 'TFR') {
          const key = `${d.id}|${h.id}`;
          if (insideTfr(p, s)) {
            if (!this.tfrInside.has(key)) {
              this.tfrInside.add(key);
              this.safety.tfrIncursions++;
              this.log('bad', `${d.id} 임시 비행금지구역 침범`, h.id, d.id);
            }
          } else this.tfrInside.delete(key);
        } else if (s.kind === 'INTRUDER' && h.position) {
          const q = h.position;
          const rx = p.x - q.x;
          const ry = p.y - q.y;
          const rz = p.z - q.z;
          const dist = Math.hypot(rx, ry, rz);
          const key = `${d.id}|${h.id}`;
          if (dist < hz.collisionM) {
            this.crash(rt, '비협조 비행체와 충돌', h.id);
            break;
          }
          if (dist < hz.nearMissM) {
            if (!this.nearMissActive.has(key)) {
              this.nearMissActive.add(key);
              this.safety.nearMisses++;
              this.log('bad', `${d.id} 비협조 비행체와 근접 ${dist.toFixed(0)}m (NMAC)`, h.id, d.id);
            }
          } else this.nearMissActive.delete(key);

          const iv = intruderVelocity(s);
          const closing = rx * (d.velocity.x - iv.x) + ry * (d.velocity.y - iv.y) + rz * (d.velocity.z - iv.z) < 0;
          const m = rt.mission;
          if (m?.hold?.reason === 'INTRUDER' && m.hold.hazardId === h.id) {
            if (dist > set.intruderClearRangeM && !closing) {
              this.log('good', `${d.id} 침입기 멀어짐 → 비행 재개`, h.id, d.id);
              this.endHold(rt, 'RESUME');
            }
            continue;
          }
          const range = s.adsb && this.linkOk(rt) ? set.adsbAlertRangeM : set.sensorRangeM;
          if (dist < range && closing && m && !m.hold && this.policies.INTRUDER !== 'IGNORE') {
            const via = s.adsb && this.linkOk(rt) ? 'ADS-B 경보' : '센서 탐지';
            let point = clone(p);
            if (this.policies.INTRUDER === 'VERTICAL') {
              const min = this.config.pathfinding.minAltitudeM;
              const max = this.config.altitude.maxM;
              const up = p.z >= q.z;
              let z = p.z + (up ? hz.verticalAvoidM : -hz.verticalAvoidM);
              if (z > max || z < min) z = p.z + (up ? -hz.verticalAvoidM : hz.verticalAvoidM);
              point = { x: p.x, y: p.y, z: Math.min(max, Math.max(min, z)) };
            }
            this.log(
              'warn',
              `${d.id} ${via} (거리 ${dist.toFixed(0)}m) → ${this.policies.INTRUDER === 'VERTICAL' ? `고도 ${point.z.toFixed(0)}m 로 회피` : '제자리 정지'}`,
              h.id,
              d.id,
            );
            this.startHold(rt, point, hz.intruderMaxHoldSec, 'INTRUDER', 'RESUME', h.id);
          }
        }
      }

      // 침입기가 사라졌는데 대기 중이면 재개
      const m = rt.mission;
      if (m?.hold?.reason === 'INTRUDER') {
        const h = this.hazards.find((x) => x.id === m.hold!.hazardId);
        if (!h || h.status !== 'ACTIVE') this.endHold(rt, 'RESUME');
      }
    }
  }

  // ── 돌발 상황: 대응 동작 ──

  private startHold(rt: DroneRuntime, point: Vec3, durSec: number, reason: HoldReason, onEnd: Hold['onEnd'], hazardId?: string) {
    const m = rt.mission;
    const d = rt.drone;
    if (!m || !AIRBORNE.has(d.phase)) return;
    const resumePhase = m.hold ? m.hold.resumePhase : d.phase;
    m.hold = { point, untilStep: this.stepCount + Math.round(durSec / this.dt), reason, hazardId, onEnd, resumePhase };
    d.alert = holdLabel[reason];
    this.setPhase(rt, 'HOLD');
    this.safety.holds++;
    this.rereserve(rt);
  }

  private endHold(rt: DroneRuntime, onEnd: Hold['onEnd']) {
    const m = rt.mission;
    if (!m?.hold) return;
    const h = m.hold;
    m.hold = null;
    if (onEnd === 'RTH') {
      this.returnHome(rt, h.reason === 'LINK' ? '통신두절 지속' : h.reason === 'OBSTACLE' ? '장애물' : '대기 시간 초과');
      return;
    }
    if (rt.drone.alert === holdLabel[h.reason]) rt.drone.alert = rt.linkLostUntilStep !== null ? '통신두절' : null;
    this.setPhase(rt, h.resumePhase);
    this.rereserve(rt);
  }

  /** 현재 위치에서 target 패드까지: [현재 → 순항 고도 → A* 경로 → 패드 상공] + 수직 하강 */
  private legsFrom(pos: Vec3, target: Vec3, alt: number): { legs: Leg[]; route: RouteInfo } | null {
    const start = { x: pos.x, y: pos.y, z: alt };
    const plan = this.planner.plan(start, { x: target.x, y: target.y, z: alt }, { allowBlockedStart: true });
    if (!plan.ok) return null;
    const cruise: Vec3[] = [clone(pos)];
    if (Math.abs(pos.z - alt) > 0.5) cruise.push(start);
    cruise.push(...plan.path.slice(1));
    if (cruise.length < 2) cruise.push({ x: target.x, y: target.y, z: alt });
    const above = cruise[cruise.length - 1];
    return {
      legs: [
        { kind: 'CRUISE', waypoints: cruise },
        { kind: 'DESCEND', waypoints: [clone(above), clone(target)] },
      ],
      route: routeInfo(plan),
    };
  }

  /** 고도를 경로 탐색 고도층에 맞춘다 */
  private snapAlt(z: number): number {
    const pf = this.config.pathfinding;
    const k = Math.round((z - pf.minAltitudeM) / pf.layerHeightM);
    return Math.min(this.config.altitude.maxM, Math.max(pf.minAltitudeM, pf.minAltitudeM + k * pf.layerHeightM));
  }

  private setOutLegs(rt: DroneRuntime, legs: Leg[], route: RouteInfo) {
    const m = rt.mission!;
    const f = flattenLegs(legs);
    m.legs.out = legs;
    m.outPath = f.path;
    m.outOffsets = f.offsets;
    m.outRoute = route;
    m.progress = { ...m.progress, stage: 'OUTBOUND', legIndex: 0, wpIndex: 1 };
    rt.drone.path = f.path;
    rt.drone.pathIndex = 1;
    rt.drone.route = route;
  }

  private setBackLegs(rt: DroneRuntime, legs: Leg[], route: RouteInfo, startNow: boolean) {
    const m = rt.mission!;
    const f = flattenLegs(legs);
    m.legs.back = legs;
    m.backPath = f.path;
    m.backOffsets = f.offsets;
    m.backRoute = route;
    if (startNow) {
      m.progress = { ...m.progress, stage: 'RETURN', legIndex: 0, wpIndex: 1 };
      rt.drone.path = f.path;
      rt.drone.pathIndex = 1;
      rt.drone.route = route;
    }
  }

  /** 하역 중·편도 중: 앞으로 쓸 복귀 경로만 새 공역으로 다시 계획 */
  private replanBack(rt: DroneRuntime) {
    const m = rt.mission!;
    const pad = this.pads.get(m.stationId)![m.padIndex];
    const r = this.legsFrom(pad, m.dockPad, m.backAlt);
    if (!r) return;
    // legsFrom 은 [현재 → 순항] 을 CRUISE 로 만들므로, 패드에서 출발하는 복귀는 앞부분을 TAKEOFF 로 나눈다
    const [cruise, descend] = r.legs;
    const top = cruise.waypoints[1];
    const legs: Leg[] = [
      { kind: 'TAKEOFF', waypoints: [clone(pad), clone(top)] },
      { kind: 'CRUISE', waypoints: cruise.waypoints.slice(1) },
      descend,
    ];
    if (legs[1].waypoints.length < 2) legs.splice(1, 1);
    this.setBackLegs(rt, legs, r.route, false);
    this.rereserve(rt);
  }

  private reroute(rt: DroneRuntime, why: string, hazardId?: string) {
    const m = rt.mission;
    const d = rt.drone;
    if (!m) return;
    if (m.hold) m.hold = null;
    const stage = m.progress.stage;
    if (stage === 'OUTBOUND') {
      const pad = this.pads.get(m.stationId)![m.padIndex];
      const r = this.legsFrom(d.position, pad, m.outAlt);
      if (!r) {
        this.log('bad', `${d.id} 우회 경로 없음 → 복귀`, hazardId, d.id);
        this.returnHome(rt, why);
        return;
      }
      this.setOutLegs(rt, r.legs, r.route);
      this.setPhase(rt, 'CRUISE');
      this.replanBack(rt);
    } else if (stage === 'RETURN') {
      const target = m.emergencyPad ?? m.dockPad;
      const r = this.legsFrom(d.position, target, m.emergencyPad ? this.snapAlt(d.position.z) : m.backAlt);
      if (!r) {
        this.log('bad', `${d.id} 복귀 우회 경로 없음 → 비상착륙`, hazardId, d.id);
        this.emergencyLandNearest(rt, why);
        return;
      }
      this.setBackLegs(rt, r.legs, r.route, true);
      this.setPhase(rt, 'RETURN');
    } else return;
    d.alert = `재경로: ${why}`;
    this.safety.reroutes++;
    this.log('good', `${d.id} ${why} → 재경로 (${r0(d.route?.lengthM)}m)`, hazardId, d.id);
    this.rereserve(rt);
  }

  private returnHome(rt: DroneRuntime, why: string) {
    const m = rt.mission;
    const d = rt.drone;
    if (!m) return;
    m.hold = null;
    const wasOutbound = m.progress.stage === 'OUTBOUND';
    const r = this.legsFrom(d.position, m.dockPad, m.backAlt);
    if (!r) {
      this.log('bad', `${d.id} 복귀 경로 없음 → 비상착륙`, undefined, d.id);
      this.emergencyLandNearest(rt, why);
      return;
    }
    if (wasOutbound) this.requeueOrder(rt, `${why}로 복귀`);
    m.emergencyPad = null;
    this.setBackLegs(rt, r.legs, r.route, true);
    this.releaseBusy(d.id);
    d.alert = `복귀: ${why}`;
    this.setPhase(rt, 'RETURN');
    this.safety.returns++;
    this.log('warn', `${d.id} ${why} → 도크 복귀 (${r0(r.route.lengthM)}m)`, undefined, d.id);
    this.rereserve(rt);
  }

  /** 가장 가까운 패드(도크·열린 스테이션)에 비상착륙 */
  private emergencyLandNearest(rt: DroneRuntime, why: string) {
    const m = rt.mission;
    const d = rt.drone;
    if (!m) return;
    m.hold = null;
    const candidates: Vec3[] = [];
    for (const pads of this.dockPads.values()) candidates.push(...pads);
    for (const [sid, pads] of this.pads) if (!this.closedStations.has(sid)) candidates.push(...pads);
    candidates.sort((a, b) => Math.hypot(a.x - d.position.x, a.y - d.position.y) - Math.hypot(b.x - d.position.x, b.y - d.position.y));
    const alt = this.snapAlt(d.position.z);
    for (const pad of candidates) {
      const r = this.legsFrom(d.position, pad, alt);
      if (!r) continue;
      if (m.progress.stage === 'OUTBOUND' && m.orderId) this.failOrder(m.orderId, `${why} 비상착륙`);
      m.orderId = null;
      d.orderId = null;
      m.emergencyPad = pad;
      this.setBackLegs(rt, r.legs, r.route, true);
      this.releaseBusy(d.id);
      d.alert = '비상착륙 이동';
      this.setPhase(rt, 'RETURN');
      this.safety.emergencyLandings++;
      this.log('warn', `${d.id} ${why} → 가장 가까운 패드로 비상착륙 (${r0(r.route.lengthM)}m)`, undefined, d.id);
      this.rereserve(rt);
      return;
    }
    this.crash(rt, `${why} (착륙지 없음)`);
  }

  private divert(rt: DroneRuntime, hazardId: string) {
    const m = rt.mission!;
    const d = rt.drone;
    const open = this.map.stations
      .filter((s) => s.id !== m.stationId && !this.closedStations.has(s.id))
      .sort((a, b) => dist2(a.position, d.position) - dist2(b.position, d.position));
    for (const st of open) {
      const pads = this.pads.get(st.id)!;
      // 지금부터 5분 동안 덜 붐비는 패드
      const load = (i: number) => (this.padBusy.get(`${st.id}#${i}`) ?? []).filter((b) => b.to >= this.stepCount).length;
      const padIndex = [...pads.keys()].sort((a, b) => load(a) - load(b))[0];
      const r = this.legsFrom(d.position, pads[padIndex], m.outAlt);
      if (!r) continue;
      const from = this.stationName(m.stationId);
      m.stationId = st.id;
      m.padIndex = padIndex;
      if (m.orderId) {
        const o = this.ordersById.get(m.orderId);
        if (o) o.stationId = st.id;
      }
      m.hold = null;
      this.setOutLegs(rt, r.legs, r.route);
      this.setPhase(rt, 'CRUISE');
      this.replanBack(rt);
      d.alert = `전환: ${st.name ?? st.id}`;
      this.safety.diverts++;
      this.log('good', `${d.id} ${from} 폐쇄 → ${st.name ?? st.id}로 전환`, hazardId, d.id);
      this.rereserve(rt);
      return;
    }
    const h = this.hazards.find((x) => x.id === hazardId);
    const end = h ? (this.hazardEnd(h) ?? this.time + 60) : this.time + 60;
    this.log('warn', `${d.id} 전환할 스테이션 없음 → 상공 대기`, hazardId, d.id);
    this.startHold(rt, clone(d.position), Math.max(1, end - this.time), 'STATION', 'RESUME', hazardId);
  }

  private crash(rt: DroneRuntime, why: string, hazardId?: string) {
    const d = rt.drone;
    const m = rt.mission;
    if (m?.orderId && m.progress.stage === 'OUTBOUND') this.failOrder(m.orderId, `${d.id} 추락`);
    rt.mission = null;
    this.table.release(d.id, 0);
    this.releaseBusy(d.id);
    d.velocity = { x: 0, y: 0, z: 0 };
    d.position = { ...d.position, z: this.groundHeight(d.position) };
    d.path = [];
    d.route = null;
    d.orderId = null;
    d.departAt = null;
    d.payloadKg = 0;
    d.alert = `추락: ${why}`;
    this.setPhase(rt, 'FAILED');
    this.safety.crashes++;
    this.log('bad', `${d.id} 추락 — ${why}`, hazardId, d.id);
  }

  private groundHeight(p: Vec3): number {
    let z = 0;
    for (const b of this.map.buildings) if (distanceToPolygon(p.x, p.y, b.footprint) === 0) z = Math.max(z, b.heightM);
    for (const h of this.hazards) {
      if (h.status === 'ACTIVE' && h.spec.kind === 'OBSTACLE' && insideObstacle({ ...p, z: 0 }, h.spec)) z = Math.max(z, h.spec.heightM);
    }
    return Math.min(p.z, z);
  }

  private cancelScheduled(rt: DroneRuntime, why: string) {
    const d = rt.drone;
    this.requeueOrder(rt, why);
    rt.mission = null;
    this.table.release(d.id, 0);
    this.releaseBusy(d.id);
    d.departAt = null;
    d.payloadKg = 0;
    d.cruiseAltM = null;
    d.path = [];
    d.route = null;
    // 적재 중이었다면 패드에서 격납고로 돌아간다
    d.position = clone(rt.slot);
    this.log('info', `${d.id} 출발 취소 (${why}) — 주문 재배정`, undefined, d.id);
  }

  private requeueOrder(rt: DroneRuntime, why: string) {
    const m = rt.mission;
    if (!m?.orderId) return;
    const o = this.ordersById.get(m.orderId);
    m.orderId = null;
    rt.drone.orderId = null;
    if (!o || o.status === 'DELIVERED') return;
    o.status = 'WAITING_DRONE';
    o.droneId = null;
    delete o.t.assigned;
    delete o.t.takeoff;
    this.queue.unshift(o.id);
    this.retryAt.delete(o.id);
    this.safety.ordersRequeued++;
    this.log('info', `주문 ${o.id} 재배정 대기 (${why})`);
  }

  private failOrder(orderId: string, why: string) {
    const o = this.ordersById.get(orderId);
    if (!o || o.status === 'DELIVERED' || o.status === 'FAILED') return;
    o.status = 'FAILED';
    this.safety.ordersFailed++;
    this.log('bad', `주문 ${o.id} 배송 실패 (${why})`);
  }

  /** 경로·대기가 바뀐 드론의 남은 예약을 지우고 새 예측으로 다시 잡는다 (비상 우선: 충돌 확인 생략) */
  private rereserve(rt: DroneRuntime) {
    const m = rt.mission;
    const d = rt.drone;
    if (!m) return;
    this.table.release(d.id, Math.floor(this.stepCount / this.stepsPerSlot));
    this.releaseBusy(d.id);
    let pred;
    try {
      pred = predictRemaining(m.legs, m.progress, d, this.stepCount, this.limits, this.dt, this.stepsPerSlot, this.table, m.hold);
    } catch {
      return;
    }
    this.table.reserve(d.id, pred.baseSlot, pred.footprint);
    if (!m.emergencyPad && pred.landedStep !== null && pred.returnStartStep !== null) {
      this.addBusy(`${m.stationId}#${m.padIndex}`, pred.landedStep, pred.returnStartStep, d.id);
    }
    this.addBusy(m.dockPadKey, pred.doneStep, pred.doneStep + this.stepsPerSlot, d.id);
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
      status: 'KITCHEN_QUEUE',
      droneId: null,
      t: { created: this.time },
    };
    this.orders.push(order);
    this.ordersById.set(id, order);
    // 주방 → 포장 → 직원 운반을 거쳐 도크에 도착하면 드론 배정 대기열에 들어간다
    this.kitchenByStore.get(store.id)!.queue.push(id);
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
      if (this.closedStations.has(o.stationId)) {
        const alt = this.policies.STATION_CLOSED === 'DIVERT' ? this.nearestOpenStation(o.stationId) : null;
        if (!alt) {
          remaining.push(orderId);
          continue;
        }
        this.log('info', `주문 ${o.id}: ${this.stationName(o.stationId)} 폐쇄 → ${alt.name ?? alt.id}로 배정`);
        o.stationId = alt.id;
      }
      const store = this.map.stores.find((s) => s.id === o.storeId)!;
      const candidates = this.runtimes
        .filter((r) => !r.mission && r.drone.phase === 'IDLE' && r.drone.swapUntil === null && r.drone.homeDockId === store.dockId)
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

  // ── 퍼스트 마일: 주방·포장·운반 ──

  private fmSteps(sec: number): number {
    return Math.max(1, Math.round((sec * this.firstMileScale!) / this.dt));
  }

  private processKitchens(step: number) {
    for (const k of this.kitchens) {
      const prof = kitchenProfile(this.config, k.storeId);
      // 조리 완료 → 포장 대기
      k.cooking = k.cooking.filter((job) => {
        if (step < job.doneStep) return true;
        const o = this.ordersById.get(job.orderId)!;
        o.status = 'PACKING';
        o.t.cookDone = this.time;
        k.packQueue.push(job.orderId);
        return false;
      });
      // 화구가 비면 다음 주문 조리 시작
      while (k.cooking.length < prof.maxCooking && k.queue.length) {
        const id = k.queue.shift()!;
        const o = this.ordersById.get(id)!;
        o.status = 'COOKING';
        o.t.cookStart = this.time;
        k.cooking.push({ orderId: id, startStep: step, doneStep: step + this.fmSteps(this.rng.range(prof.cookMinSec, prof.cookMaxSec)) });
      }
      // 포장 완료 → 운반 대기
      k.packing = k.packing.filter((job) => {
        if (step < job.doneStep) return true;
        const o = this.ordersById.get(job.orderId)!;
        o.status = 'READY';
        o.t.packDone = this.time;
        k.ready.push(job.orderId);
        return false;
      });
      while (k.packing.length < prof.packers && k.packQueue.length) {
        const id = k.packQueue.shift()!;
        this.ordersById.get(id)!.t.packStart = this.time;
        k.packing.push({ orderId: id, startStep: step, doneStep: step + this.fmSteps(this.rng.range(prof.packMinSec, prof.packMaxSec)) });
      }
    }

    for (const r of this.runners) {
      const k = this.kitchenByStore.get(r.storeId)!;
      const walk = this.map.stores.find((x) => x.id === r.storeId)!.walkToDockSec;
      if (r.phase === 'IDLE' && k.ready.length) {
        r.orderIds = k.ready.splice(0, kitchenProfile(this.config, r.storeId).runnerCapacity);
        r.phase = 'TO_DOCK';
        r.startStep = step;
        r.endStep = step + this.fmSteps(walk);
        for (const id of r.orderIds) {
          const o = this.ordersById.get(id)!;
          o.status = 'TO_DOCK';
          o.t.pickedUp = this.time;
        }
      } else if (r.phase === 'TO_DOCK' && step >= r.endStep) {
        // 도크 선반에 내려놓고 배정 대기열로
        for (const id of r.orderIds) {
          const o = this.ordersById.get(id)!;
          o.status = 'WAITING_DRONE';
          o.t.atDock = this.time;
          this.queue.push(id);
        }
        r.orderIds = [];
        r.phase = 'BACK';
        r.startStep = step;
        r.endStep = step + this.fmSteps(walk);
      } else if (r.phase === 'BACK' && step >= r.endStep) {
        r.phase = 'IDLE';
      }
    }
  }

  private startLoading(rt: DroneRuntime) {
    const m = rt.mission!;
    const d = rt.drone;
    m.loading = true;
    d.position = clone(m.dockPad);
    d.payloadKg = m.payloadKg;
    const o = m.orderId ? this.ordersById.get(m.orderId) : undefined;
    if (o) {
      o.status = 'LOADING';
      o.t.loadStart = this.time;
    }
  }

  private nearestOpenStation(fromId: string): Station | null {
    const from = this.stations.get(fromId)!.position;
    return (
      this.map.stations
        .filter((s) => s.id !== fromId && !this.closedStations.has(s.id))
        .sort((a, b) => dist2(a.position, from) - dist2(b.position, from))[0] ?? null
    );
  }

  private flyMission(cmd: Extract<SimCommand, { type: 'FLY_MISSION' }>): DispatchResult {
    const dock = this.docks.get(cmd.fromDockId);
    if (!dock) return { ok: false, reason: `없는 도크: ${cmd.fromDockId}` };
    if (!this.stations.has(cmd.toStationId)) return { ok: false, reason: `없는 스테이션: ${cmd.toStationId}` };
    if (this.closedStations.has(cmd.toStationId)) return { ok: false, reason: `${this.stationName(cmd.toStationId)} 는 폐쇄 중입니다` };
    const payload = cmd.payloadKg ?? this.config.fleet.missionPayloadKg;
    if (payload > this.config.drone.maxPayloadKg) {
      return { ok: false, reason: `탑재 중량 ${payload}kg 이 최대 ${this.config.drone.maxPayloadKg}kg 을 넘습니다` };
    }
    const rt = cmd.droneId
      ? this.byId.get(cmd.droneId)
      : this.runtimes
          .filter((r) => !r.mission && r.drone.phase === 'IDLE' && r.drone.swapUntil === null && r.drone.homeDockId === dock.id)
          .sort((a, b) => b.drone.battery - a.drone.battery)[0];
    if (!rt) return { ok: false, reason: `${dock.name ?? dock.id} 에 대기 중인 드론이 없습니다` };
    if (rt.mission) return { ok: false, reason: `${rt.drone.id} 는 이미 임무 중입니다` };
    if (rt.drone.phase === 'FAILED') return { ok: false, reason: `${rt.drone.id} 는 운용 불가 상태입니다` };
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
    const loadSteps = Math.round(this.config.kitchen.loadSec / this.dt);
    const baseSlot = Math.floor((this.stepCount + loadSteps) / this.stepsPerSlot) + 1;
    const delaySlots: number[] = [];
    const maxDelay = this.useReservations ? t.maxDepartureDelaySec : 0;
    for (let s = 0; s <= maxDelay + 1e-9; s += t.delayStepSec) delaySlots.push(Math.round(s / t.slotSec));
    const cruise = this.config.altitude.cruiseM;
    const alts: readonly (readonly [number, number])[] = this.useReservations ? t.altitudePairsM : [[cruise, cruise]];

    // 예측은 (도크 패드, 스테이션 패드, 고도) 로 정해지므로 모든 드론이 공유하고, 출발 지연과 무관하다
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
            if (this.padKeyOverlaps(`${stationId}#${p}`, from, to)) continue;
            // 도크 패드: 출발 직전 1칸, 복귀 착륙 직후 1칸 동안 비어 있어야 한다
            const dkey = `${dockId}#d${dp}`;
            const done = departStep + c.pred.doneStep;
            const padFrom = departStep - Math.max(loadSteps, this.stepsPerSlot);
            if (this.padKeyOverlaps(dkey, padFrom, departStep)) continue;
            if (this.padKeyOverlaps(dkey, done, done + this.stepsPerSlot)) continue;
            if (this.useReservations && !this.table.isFree(rt.drone.id, departSlot, c.pred.footprint)) continue;

            this.commit(rt, c, departStep, departSlot, stationId, orderId, payloadKg, from, to, dkey, departStep - loadSteps);
            this.addBusy(dkey, padFrom, departStep, rt.drone.id);
            this.addBusy(dkey, done, done + this.stepsPerSlot, rt.drone.id);
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
    dockPadKey: string,
    loadStartStep: number,
  ) {
    // 예약 테이블을 꺼도 예약은 기록한다 (다시 켰을 때 새 임무가 기존 비행을 피하도록)
    this.table.reserve(rt.drone.id, departSlot, c.pred.footprint);
    this.addBusy(`${stationId}#${c.padIndex}`, padFrom, padTo, rt.drone.id);

    // 후보는 캐시에서 공유되므로 경로 배열을 바꿀 수 있게 구간 목록은 복사한다
    rt.mission = {
      orderId,
      stationId,
      padIndex: c.padIndex,
      dockPad: c.dockPad,
      dockPadKey,
      legs: { out: [...c.legs.out], back: [...c.legs.back], dwellSteps: c.legs.dwellSteps, departStep },
      progress: newProgress(),
      outPath: c.outPath,
      outOffsets: c.outOffsets,
      backPath: c.backPath,
      backOffsets: c.backOffsets,
      outRoute: c.outRoute,
      backRoute: c.backRoute,
      outAlt: c.outAlt,
      backAlt: c.backAlt,
      hold: null,
      emergencyPad: null,
      loadStartStep,
      loading: false,
      payloadKg,
    };
    const d = rt.drone;
    d.departAt = departStep * this.dt;
    d.orderId = orderId;
    // 화물은 적재를 시작할 때 싣는다
    d.payloadKg = 0;
    d.cruiseAltM = c.outAlt;
    d.pathIndex = 0;
    this.missionsScheduled++;
  }

  private addBusy(key: string, from: number, to: number, owner: string) {
    if (!this.padBusy.has(key)) this.padBusy.set(key, []);
    this.padBusy.get(key)!.push({ from, to, owner });
  }

  private releaseBusy(owner: string) {
    for (const [k, list] of this.padBusy) {
      const kept = list.filter((b) => b.owner !== owner);
      if (kept.length) this.padBusy.set(k, kept);
      else this.padBusy.delete(k);
    }
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

  private stationName(id: string): string {
    return this.stations.get(id)?.name ?? id;
  }

  private log(severity: HazardLogSeverity, text: string, hazardId?: string, droneId?: string) {
    this.hazardLog.push({ t: this.time, severity, text, hazardId, droneId });
    if (this.hazardLog.length > HAZARD_LOG_LIMIT) this.hazardLog.splice(0, this.hazardLog.length - HAZARD_LOG_LIMIT);
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

export function hazardName(s: HazardSpec): string {
  switch (s.kind) {
    case 'TFR':
      return '임시 비행금지구역';
    case 'OBSTACLE':
      return '미등록 장애물';
    case 'INTRUDER':
      return '비협조 비행체';
    case 'BATTERY_DROP':
      return '배터리 급감';
    case 'LINK_LOSS':
      return '통신 두절';
    case 'STATION_CLOSED':
      return '스테이션 폐쇄';
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

/** crash() 가 단계를 바꾸므로 타입 좁히기를 피하려고 함수로 확인한다 */
const isFailed = (d: Drone) => d.phase === 'FAILED';
const dist2 = (a: Vec3, b: Vec3) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
const r0 = (v: number | undefined) => (v === undefined ? '-' : v.toFixed(0));
