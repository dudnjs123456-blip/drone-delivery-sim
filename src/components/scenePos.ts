/**
 * 화면에 그릴 위치 계산 (드론·직원). 3D 장면과 카메라가 같은 값을 쓰도록 한 곳에 둔다.
 * - 드론: 50ms 스텝 사이 보간 + 격납고 ↔ 패드 지상 이동(taxi) 애니메이션
 * - 직원: 운반 경로를 따라 진행률만큼
 */
import { defaultConfig } from '@/sim/config';
import { defaultMap } from '@/sim/map/defaultMap';
import { type RunnerState, pointAlongRunnerPath, runnerPath } from '@/sim/orders/firstMile';
import type { Drone, Vec3 } from '@/sim/types';
import { engine, runner } from '@/store/simStore';

const DT = defaultConfig.time.fixedDtSec;

/** 스텝 사이까지 보간한 시뮬레이션 시각 (s) */
export function simTimeNow(): number {
  return engine.getSnapshot().time + runner.alpha * DT;
}

const smooth = (f: number) => f * f * (3 - 2 * f);

export function droneDisplayPos(d: Drone, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  const tx = d.taxi;
  if (tx) {
    const t = simTimeNow();
    if (t < tx.end) {
      const f = smooth(Math.min(1, Math.max(0, (t - tx.start) / Math.max(1e-6, tx.end - tx.start))));
      out.x = tx.from.x + (tx.to.x - tx.from.x) * f;
      out.y = tx.from.y + (tx.to.y - tx.from.y) * f;
      out.z = tx.from.z + (tx.to.z - tx.from.z) * f;
      return out;
    }
  }
  return runner.interpolatedPosition(d, out);
}

const pathCache = new Map<string, Vec3[]>();
export function storeRunnerPath(storeId: string): Vec3[] {
  let p = pathCache.get(storeId);
  if (!p) {
    p = runnerPath(defaultMap, defaultMap.stores.find((s) => s.id === storeId)!);
    pathCache.set(storeId, p);
  }
  return p;
}

/** 직원 위치와 이동 중인지 */
export function runnerDisplayPos(r: RunnerState): { pos: Vec3; moving: boolean } {
  const step = simTimeNow() / DT;
  const span = Math.max(1, r.endStep - r.startStep);
  const f = r.phase === 'IDLE' ? 0 : Math.min(1, Math.max(0, (step - r.startStep) / span));
  return { pos: pointAlongRunnerPath(storeRunnerPath(r.storeId), r.phase === 'BACK' ? 1 - f : f), moving: r.phase !== 'IDLE' && f < 1 };
}
