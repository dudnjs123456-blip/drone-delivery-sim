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
import { defaultMap } from '@/sim/map/defaultMap';
import type { FlightPhase, Vec3 } from '@/sim/types';

export const engine: SimEngine = new LocalSimEngine();
engine.load(defaultMap, defaultConfig, 1);
export const runner = new SimRunner(engine, defaultConfig.time);

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
}

interface SimUiState {
  paused: boolean;
  speed: number;
  time: number;
  drones: DroneView[];
  phaseLog: readonly PhaseChange[];
  message: { text: string; ok: boolean } | null;
  setSpeed: (s: number) => void;
  togglePause: () => void;
  reset: () => void;
  flyMission: (fromDockId: string, toStationId: string) => void;
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
  }));
}

export const useSimStore = create<SimUiState>((set, get) => ({
  paused: false,
  speed: 1,
  time: 0,
  drones: readDrones(),
  phaseLog: [],
  message: null,

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
  flyMission: (fromDockId, toStationId) => {
    const r = engine.dispatch({ type: 'FLY_MISSION', fromDockId, toStationId });
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
