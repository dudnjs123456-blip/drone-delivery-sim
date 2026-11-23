/**
 * 시뮬레이션 엔진·실행기를 보관하고, UI 용 요약 상태를 zustand 로 노출한다.
 * 3D 렌더링은 engine.getSnapshot() 을 useFrame 에서 직접 읽고(리렌더 없음),
 * 패널·미니맵은 publish() 가 10Hz 로 복사해 주는 값을 구독한다.
 */
import { create } from 'zustand';
import { defaultConfig } from '@/sim/config';
import { LocalSimEngine } from '@/sim/engine/LocalSimEngine';
import type { PhaseChange, SimEngine } from '@/sim/engine/SimEngine';
import { SimRunner } from '@/sim/engine/SimRunner';
import { buildTripLegs, flattenLegs } from '@/sim/flight/route';
import { defaultMap } from '@/sim/map/defaultMap';
import { type PlanResult, PathPlanner } from '@/sim/pathfinding/planner';
import type { FlightPhase, RouteInfo, Vec3 } from '@/sim/types';

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
  const result = previewPlanner.plan({ ...dock.position, z }, { ...station.position, z });
  const fullPath = result.ok
    ? flattenLegs(buildTripLegs(dock.position, station.position, z, result.path.slice(1, -1))).path
    : [];
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
  /** 엔진의 경로 배열 참조 (비행마다 새 배열이 된다) */
  path: readonly Vec3[];
  pathIndex: number;
  route: RouteInfo | null;
}

interface SimUiState {
  paused: boolean;
  speed: number;
  time: number;
  drones: DroneView[];
  phaseLog: readonly PhaseChange[];
  message: { text: string; ok: boolean } | null;
  selection: { dockId: string; stationId: string };
  preview: RoutePreview | null;
  select: (sel: Partial<{ dockId: string; stationId: string }>) => void;
  setSpeed: (s: number) => void;
  togglePause: () => void;
  reset: () => void;
  flyMission: () => void;
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
    path: d.path,
    pathIndex: d.pathIndex,
    route: d.route,
  }));
}

export const useSimStore = create<SimUiState>((set, get) => ({
  paused: false,
  speed: 1,
  time: 0,
  drones: readDrones(),
  phaseLog: [],
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
    set({ message: r.ok ? { text: '출발했습니다', ok: true } : { text: r.reason, ok: false } });
    get().publish();
  },
  publish: () => {
    const snap = engine.getSnapshot();
    const log = snap.phaseLog;
    set((s) => ({
      time: snap.time,
      drones: readDrones(),
      // 로그가 바뀌었을 때만 새 배열로 (구독자 리렌더 최소화)
      phaseLog:
        s.phaseLog.length === log.length && s.phaseLog[s.phaseLog.length - 1] === log[log.length - 1]
          ? s.phaseLog
          : log.slice(),
    }));
  },
}));
