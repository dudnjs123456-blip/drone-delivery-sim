/**
 * 시뮬레이션 엔진·실행기를 보관하고, UI 용 요약 상태를 zustand 로 노출한다.
 * 3D 렌더링은 engine.getSnapshot() 을 useFrame 에서 직접 읽고(리렌더 없음),
 * 패널·미니맵은 publish() 가 10Hz 로 복사해 주는 값을 구독한다.
 */
import { create } from 'zustand';
import { defaultConfig } from '@/sim/config';
import { LocalSimEngine } from '@/sim/engine/LocalSimEngine';
import type { PhaseChange, SimEngine, SimEvent, TrafficStats } from '@/sim/engine/SimEngine';
import { SimRunner } from '@/sim/engine/SimRunner';
import { buildTripLegs, flattenLegs } from '@/sim/flight/route';
import { defaultMap } from '@/sim/map/defaultMap';
import { dockLaunchPads, stationPads } from '@/sim/map/pads';
import { type PlanResult, PathPlanner } from '@/sim/pathfinding/planner';
import type { HazardLogEntry, HazardSettings, HazardSpec, HazardState, ResponsePolicies, SafetyStats } from '@/sim/hazards/types';
import { kitchenProfile } from '@/sim/orders/firstMile';
import { SCENARIOS, type ScenarioRun, scenarioResult } from './scenarios';
import type { FlightPhase, Order, OrderStatus, RouteInfo, Vec3 } from '@/sim/types';

export const engine: SimEngine = new LocalSimEngine();
engine.load(defaultMap, defaultConfig, 1);
export const runner = new SimRunner(engine, defaultConfig.time);

/** 출발 전 경로 미리보기용 계획기 (엔진과 별도 인스턴스, 처음 쓸 때 만든다) */
let previewPlanner: PathPlanner | null = null;

export interface RoutePreview {
  dockId: string;
  stationId: string;
  result: PlanResult;
  /** 이륙·순항·하강을 포함한 전체 경로 (성공 시) */
  fullPath: Vec3[];
}

function computePreview(dockId: string, stationId: string): RoutePreview | null {
  const dock = defaultMap.docks.find((d) => d.id === dockId);
  const station = defaultMap.stations.find((s) => s.id === stationId);
  if (!dock || !station) return null;
  previewPlanner ??= new PathPlanner(defaultMap, defaultConfig);
  const z = defaultConfig.altitude.cruiseM;
  // 실제 비행과 같이 첫 번째 도크 패드 → 첫 번째 스테이션 패드
  const from = dockLaunchPads(defaultMap, dock)[0];
  const to = stationPads(station)[0];
  const result = previewPlanner.plan({ ...from, z }, { ...to, z });
  const fullPath = result.ok ? flattenLegs(buildTripLegs(from, to, z, result.path.slice(1, -1))).path : [];
  return { dockId, stationId, result, fullPath };
}

export interface DroneView {
  id: string;
  phase: FlightPhase;
  position: Vec3;
  velocity: Vec3;
  battery: number;
  payloadKg: number;
  homeDockId: string;
  orderId: string | null;
  /** 엔진의 경로 배열 참조 (비행마다 새 배열이 된다) */
  path: readonly Vec3[];
  pathIndex: number;
  route: RouteInfo | null;
  departAt: number | null;
  swapUntil: number | null;
  cruiseAltM: number | null;
  headingRad: number;
  alert: string | null;
  linkLostUntil: number | null;
  taxi: { from: Vec3; to: Vec3; start: number; end: number } | null;
  ghostPath: Vec3[] | null;
  ghostUntil: number | null;
}

export interface Toast {
  key: number;
  t: number;
  text: string;
  severity: 'info' | 'warn' | 'bad' | 'good';
  droneId?: string;
  /** 표시 시작 (실제 시각 ms) */
  shownAt: number;
}

/** 알림을 화면에 두는 실제 시간 (ms) */
const TOAST_MS = 7000;
const MAX_TOASTS = 5;
let toastSeq = 0;

/** 주문 1건의 구간 (완료 주문 평균) */
export const ORDER_SEGMENTS = [
  { key: 'kitchenWait', label: '주방 대기', from: 'created', to: 'cookStart', color: '#94a3b8' },
  { key: 'cook', label: '조리', from: 'cookStart', to: 'cookDone', color: '#f97316' },
  { key: 'pack', label: '포장', from: 'cookDone', to: 'packDone', color: '#a16207' },
  { key: 'carryWait', label: '운반 대기', from: 'packDone', to: 'pickedUp', color: '#d6d3d1' },
  { key: 'carry', label: '도크까지', from: 'pickedUp', to: 'atDock', color: '#db2777' },
  { key: 'droneWait', label: '드론 대기', from: 'atDock', to: 'loadStart', color: '#64748b' },
  { key: 'load', label: '적재', from: 'loadStart', to: 'takeoff', color: '#7c3aed' },
  { key: 'flight', label: '비행', from: 'takeoff', to: 'landed', color: '#0284c7' },
] as const;
export type SegmentKey = (typeof ORDER_SEGMENTS)[number]['key'];

export interface KitchenView {
  storeId: string;
  dockId: string;
  queue: number;
  /** 조리 중 주문별 진행률 0~1 */
  cooking: number[];
  maxCooking: number;
  /** 포장 대기 + 포장 중 */
  packing: number;
  ready: number;
}

export interface RunnerView {
  id: string;
  storeId: string;
  phase: 'IDLE' | 'TO_DOCK' | 'BACK';
  carrying: number;
  /** 이동 시작·끝 시각 (s) */
  start: number;
  end: number;
}

export interface OrderSummary {
  total: number;
  byStatus: Partial<Record<OrderStatus, number>>;
  /** 완료 주문의 구간별 평균 (s) */
  avgSegments: Partial<Record<SegmentKey, number>>;
  /** 도크별 적재 선반에서 드론을 기다리는 주문 수 */
  shelfByDock: Record<string, number>;
  /** 완료 주문 평균: 주문 → 이륙, 주문 → 완료 (s) */
  avgWaitSec: number | null;
  avgTotalSec: number | null;
  recent: Order[];
}

interface SimUiState {
  paused: boolean;
  speed: number;
  time: number;
  drones: DroneView[];
  phaseLog: readonly PhaseChange[];
  orders: OrderSummary;
  traffic: TrafficStats;
  alerts: readonly SimEvent[];
  peakOrdersPerMin: number | null;
  hazards: readonly HazardState[];
  hazardLog: readonly HazardLogEntry[];
  safety: SafetyStats;
  policies: ResponsePolicies;
  hazardSettings: HazardSettings;
  kitchens: KitchenView[];
  runners: RunnerView[];
  firstMileScale: number;
  scenario: ScenarioRun | null;
  toasts: Toast[];
  message: { text: string; ok: boolean } | null;
  selection: { dockId: string; stationId: string };
  preview: RoutePreview | null;
  select: (sel: Partial<{ dockId: string; stationId: string }>) => void;
  setSpeed: (s: number) => void;
  togglePause: () => void;
  reset: () => void;
  flyMission: () => void;
  createOrder: () => void;
  setPeak: (perMin: number | null) => void;
  setReservations: (enabled: boolean) => void;
  injectHazard: (spec: HazardSpec, atSec?: number) => { ok: boolean; text: string };
  cancelHazard: (id: string) => void;
  setPolicies: (p: Partial<ResponsePolicies>) => void;
  setHazardSettings: (s: Partial<HazardSettings>) => void;
  setFirstMileScale: (scale: number) => void;
  /** 원클릭 시나리오 시작. 띄운 드론 id 를 돌려준다 */
  runScenario: (presetId: string) => { ok: true; droneId: string } | { ok: false; text: string };
  dismissToast: (key: number) => void;
  publish: () => void;
}

function readDrones(): DroneView[] {
  return engine.getSnapshot().drones.map((d) => ({
    id: d.id,
    phase: d.phase,
    position: { ...d.position },
    velocity: { ...d.velocity },
    battery: d.battery,
    payloadKg: d.payloadKg,
    homeDockId: d.homeDockId,
    orderId: d.orderId,
    path: d.path,
    pathIndex: d.pathIndex,
    route: d.route,
    departAt: d.departAt,
    swapUntil: d.swapUntil,
    cruiseAltM: d.cruiseAltM,
    headingRad: d.headingRad,
    alert: d.alert,
    linkLostUntil: d.linkLostUntil,
    taxi: d.taxi,
    ghostPath: d.ghostPath,
    ghostUntil: d.ghostUntil,
  }));
}

const RECENT_ORDERS = 8;

/** 새로 생긴 돌발 상황 로그를 알림으로 만들고, 오래된 알림은 지운다 */
function nextToasts(cur: Toast[], prevLog: readonly HazardLogEntry[], log: readonly HazardLogEntry[]): Toast[] {
  const now = Date.now();
  let out = cur.filter((t) => now - t.shownAt < TOAST_MS);
  if (log.length && log.at(-1) !== prevLog.at(-1)) {
    // 이전에 본 마지막 항목 뒤부터가 새 항목 (로그 앞부분이 잘려도 동작하도록 참조로 찾는다)
    const last = prevLog.at(-1);
    const from = last ? log.lastIndexOf(last) + 1 : 0;
    for (const e of log.slice(from)) {
      out.push({ key: ++toastSeq, t: e.t, text: e.text, severity: e.severity, droneId: e.droneId, shownAt: now });
    }
  }
  if (out.length > MAX_TOASTS) out = out.slice(out.length - MAX_TOASTS);
  return out.length === cur.length && out.every((t, i) => t === cur[i]) ? cur : out;
}

/** 시나리오 진행: 이륙 → 순항 4초 뒤 주입 → 귀환(또는 운용 불가) 시 결과 */
function tickScenario(sc: ScenarioRun | null, snap: ReturnType<SimEngine['getSnapshot']>, save: (s: ScenarioRun) => void) {
  if (!sc || sc.stage === 'DONE') return;
  const d = snap.drones.find((x) => x.id === sc.droneId);
  const p = SCENARIOS.find((x) => x.id === sc.presetId);
  if (!d || !p) return;
  const t = snap.time;
  if (sc.stage === 'LAUNCHING' && d.phase === 'CRUISE') {
    save({ ...sc, stage: 'CRUISING', cruiseSince: t });
  } else if (sc.stage === 'CRUISING' && t - (sc.cruiseSince ?? t) >= 4) {
    const r = engine.dispatch({ type: 'INJECT_HAZARD', spec: p.build(d) });
    save({ ...sc, stage: 'INJECTED', injectedAt: t, hazardId: r.ok ? r.hazardId : undefined });
  } else if (sc.stage === 'INJECTED' && t - (sc.injectedAt ?? t) > 1 && (d.phase === 'IDLE' || d.phase === 'FAILED')) {
    const delivered = snap.phaseLog.some((c) => c.droneId === d.id && c.to === 'LANDED' && c.t >= sc.startedAt);
    save({ ...sc, stage: 'DONE', result: scenarioResult(sc.before, snap.safety, delivered, d.phase === 'FAILED', t - sc.startedAt) });
  } else if (t - sc.startedAt > 1200) {
    save({ ...sc, stage: 'DONE', result: { safe: false, delivered: false, durationSec: t - sc.startedAt, lines: [{ text: '시간 초과 (20분)', tone: 'warn' }] } });
  }
}

function readKitchens(): KitchenView[] {
  const snap = engine.getSnapshot();
  const step = Math.round(snap.time / defaultConfig.time.fixedDtSec);
  return snap.kitchens.map((k) => ({
    storeId: k.storeId,
    dockId: k.dockId,
    queue: k.queue.length,
    cooking: k.cooking.map((j) => Math.min(1, (step - j.startStep) / Math.max(1, j.doneStep - j.startStep))),
    maxCooking: kitchenProfile(defaultConfig, k.storeId).maxCooking,
    packing: k.packQueue.length + k.packing.length,
    ready: k.ready.length,
  }));
}

function summarizeOrders(orders: readonly Order[]): OrderSummary {
  const byStatus: Partial<Record<OrderStatus, number>> = {};
  const segSum: Partial<Record<SegmentKey, number>> = {};
  const shelfByDock: Record<string, number> = {};
  let waitSum = 0;
  let totalSum = 0;
  let done = 0;
  for (const o of orders) {
    byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
    if (o.status === 'WAITING_DRONE') {
      const dock = defaultMap.stores.find((st) => st.id === o.storeId)?.dockId ?? '';
      shelfByDock[dock] = (shelfByDock[dock] ?? 0) + 1;
    }
    if (o.status === 'DELIVERED') {
      for (const seg of ORDER_SEGMENTS) {
        const a = o.t[seg.from];
        const b = o.t[seg.to];
        if (a !== undefined && b !== undefined) segSum[seg.key] = (segSum[seg.key] ?? 0) + (b - a);
      }
    }
    if (o.status === 'DELIVERED' && o.t.takeoff !== undefined && o.t.delivered !== undefined) {
      waitSum += o.t.takeoff - o.t.created;
      totalSum += o.t.delivered - o.t.created;
      done++;
    }
  }
  const avgSegments: Partial<Record<SegmentKey, number>> = {};
  if (done) for (const k of Object.keys(segSum) as SegmentKey[]) avgSegments[k] = segSum[k]! / done;
  return {
    total: orders.length,
    byStatus,
    avgSegments,
    shelfByDock,
    avgWaitSec: done ? waitSum / done : null,
    avgTotalSec: done ? totalSum / done : null,
    recent: orders.slice(-RECENT_ORDERS).reverse().map((o) => ({ ...o, t: { ...o.t } })),
  };
}

export const useSimStore = create<SimUiState>((set, get) => ({
  paused: false,
  speed: 1,
  time: 0,
  drones: readDrones(),
  phaseLog: [],
  orders: summarizeOrders([]),
  traffic: engine.getSnapshot().traffic,
  alerts: [],
  peakOrdersPerMin: null,
  hazards: [],
  hazardLog: [],
  safety: engine.getSnapshot().safety,
  policies: engine.getSnapshot().policies,
  hazardSettings: engine.getSnapshot().hazardSettings,
  kitchens: readKitchens(),
  runners: [],
  firstMileScale: engine.getSnapshot().firstMileScale,
  scenario: null,
  toasts: [],
  message: null,
  selection: { dockId: defaultMap.docks[0].id, stationId: defaultMap.stations[0].id },
  preview: null,

  select: (sel) => {
    const selection = { ...get().selection, ...sel };
    set({ selection, preview: computePreview(selection.dockId, selection.stationId), message: null });
  },
  setSpeed: (speed) => {
    runner.speed = speed;
    set({ speed });
  },
  togglePause: () => {
    runner.paused = !runner.paused;
    set({ paused: runner.paused });
  },
  reset: () => {
    runner.reset();
    set({ message: null });
    get().publish();
  },
  flyMission: () => {
    const { dockId, stationId } = get().selection;
    const r = engine.dispatch({ type: 'FLY_MISSION', fromDockId: dockId, toStationId: stationId });
    set({ message: r.ok ? { text: `${r.droneId} 배정`, ok: true } : { text: r.reason, ok: false } });
    get().publish();
  },
  createOrder: () => {
    const r = engine.dispatch({ type: 'CREATE_ORDER' });
    set({ message: r.ok ? { text: `주문 ${r.orderId} 접수`, ok: true } : { text: r.reason, ok: false } });
    get().publish();
  },
  setPeak: (perMin) => {
    engine.dispatch({ type: 'SET_PEAK_MODE', ordersPerMin: perMin });
    get().publish();
  },
  setReservations: (enabled) => {
    engine.dispatch({ type: 'SET_RESERVATIONS', enabled });
    get().publish();
  },
  injectHazard: (spec, atSec) => {
    const r = engine.dispatch({ type: 'INJECT_HAZARD', spec, atSec });
    get().publish();
    return r.ok ? { ok: true, text: `${r.hazardId} 등록` } : { ok: false, text: r.reason };
  },
  cancelHazard: (hazardId) => {
    engine.dispatch({ type: 'CANCEL_HAZARD', hazardId });
    get().publish();
  },
  setPolicies: (policies) => {
    engine.dispatch({ type: 'SET_POLICIES', policies });
    get().publish();
  },
  setHazardSettings: (settings) => {
    engine.dispatch({ type: 'SET_HAZARD_SETTINGS', settings });
    get().publish();
  },
  setFirstMileScale: (scale) => {
    engine.dispatch({ type: 'SET_FIRST_MILE_SCALE', scale });
    get().publish();
  },
  runScenario: (presetId) => {
    const p = SCENARIOS.find((x) => x.id === presetId);
    if (!p) return { ok: false, text: `없는 시나리오: ${presetId}` };
    const r = engine.dispatch({ type: 'FLY_MISSION', fromDockId: p.fromDockId, toStationId: p.toStationId });
    if (!r.ok || !r.droneId) {
      const text = r.ok ? '드론을 띄우지 못했습니다' : r.reason;
      set({ message: { text, ok: false } });
      return { ok: false, text };
    }
    const snap = engine.getSnapshot();
    // 1배속은 결과까지 몇 분 걸리고 20배속은 반응을 놓치므로 5배속으로 맞춘다
    if (runner.speed !== 5) get().setSpeed(5);
    if (runner.paused) get().togglePause();
    set({
      scenario: {
        presetId,
        droneId: r.droneId,
        stage: 'LAUNCHING',
        startedAt: snap.time,
        policyLabel: snap.policies[p.kind],
        before: { ...snap.safety },
      },
    });
    get().publish();
    return { ok: true, droneId: r.droneId };
  },
  dismissToast: (key) => set((s) => ({ toasts: s.toasts.filter((t) => t.key !== key) })),
  publish: () => {
    const snap = engine.getSnapshot();
    tickScenario(get().scenario, snap, (scenario) => set({ scenario }));
    const log = snap.phaseLog;
    set((s) => ({
      time: snap.time,
      drones: readDrones(),
      // 로그가 바뀌었을 때만 새 배열로 (구독자 리렌더 최소화)
      phaseLog:
        s.phaseLog.length === log.length && s.phaseLog[s.phaseLog.length - 1] === log[log.length - 1]
          ? s.phaseLog
          : log.slice(),
      orders: summarizeOrders(snap.orders),
      traffic: { ...snap.traffic },
      alerts: snap.activeAlerts.length === 0 && s.alerts.length === 0 ? s.alerts : snap.activeAlerts.slice(),
      peakOrdersPerMin: snap.peakOrdersPerMin,
      hazards: snap.hazards.map((h) => ({ ...h, position: h.position ? { ...h.position } : undefined })),
      hazardLog: s.hazardLog.length === snap.hazardLog.length && s.hazardLog.at(-1) === snap.hazardLog.at(-1) ? s.hazardLog : snap.hazardLog.slice(),
      safety: { ...snap.safety },
      policies: snap.policies,
      hazardSettings: snap.hazardSettings,
      kitchens: readKitchens(),
      runners: snap.runners.map((r) => ({
        id: r.id,
        storeId: r.storeId,
        phase: r.phase,
        carrying: r.orderIds.length,
        start: r.startStep * defaultConfig.time.fixedDtSec,
        end: r.endStep * defaultConfig.time.fixedDtSec,
      })),
      firstMileScale: snap.firstMileScale,
      toasts: nextToasts(s.toasts, s.hazardLog, snap.hazardLog),
    }));
  },
}));
