/**
 * 고정 타임스텝 실행기.
 * 렌더 프레임마다 실제 경과 시간 × 배속만큼 시뮬레이션 시간을 쌓고, 고정 dt 단위로 엔진을 진행한다.
 * 렌더링은 직전 스텝과 현재 스텝 사이를 alpha 로 보간해 50ms 단위의 끊김을 숨긴다.
 */
import type { SimConfig } from '../config';
import type { Drone, Vec3 } from '../types';
import type { SimEngine } from './SimEngine';

/** 탭 전환 등으로 한 프레임이 너무 길어질 때 한 번에 따라잡을 최대 실제 시간 (s) */
const MAX_REAL_DT = 0.25;

export class SimRunner {
  speed = 1;
  paused = false;
  private acc = 0;
  private prev = new Map<string, Vec3>();
  private readonly dt: number;

  constructor(
    readonly engine: SimEngine,
    private readonly timeCfg: SimConfig['time'],
  ) {
    this.dt = timeCfg.fixedDtSec;
  }

  /** 실제 경과 시간(s)을 받아 필요한 만큼 스텝을 실행하고, 실행한 스텝 수를 돌려준다 */
  advance(realDtSec: number): number {
    if (this.paused) return 0;
    this.acc += Math.min(Math.max(realDtSec, 0), MAX_REAL_DT) * this.speed;
    let steps = 0;
    while (this.acc >= this.dt && steps < this.timeCfg.maxStepsPerFrame) {
      this.capturePrev();
      this.engine.step(this.dt);
      this.acc -= this.dt;
      steps++;
    }
    // 상한에 걸리면 남은 시간은 버린다 (시뮬레이션이 실제보다 느려질 뿐 폭주하지 않음)
    if (steps >= this.timeCfg.maxStepsPerFrame) this.acc = 0;
    return steps;
  }

  /** 직전 스텝과 현재 스텝 사이의 보간 비율 0~1 */
  get alpha(): number {
    return this.acc / this.dt;
  }

  /** 렌더링용 보간 위치 */
  interpolatedPosition(drone: Drone, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
    const p = drone.position;
    const q = this.prev.get(drone.id);
    if (!q) {
      out.x = p.x;
      out.y = p.y;
      out.z = p.z;
      return out;
    }
    const a = this.alpha;
    out.x = q.x + (p.x - q.x) * a;
    out.y = q.y + (p.y - q.y) * a;
    out.z = q.z + (p.z - q.z) * a;
    return out;
  }

  reset(): void {
    this.acc = 0;
    this.prev.clear();
    this.engine.reset();
  }

  private capturePrev() {
    for (const d of this.engine.getSnapshot().drones) {
      const q = this.prev.get(d.id);
      if (q) {
        q.x = d.position.x;
        q.y = d.position.y;
        q.z = d.position.z;
      } else {
        this.prev.set(d.id, { x: d.position.x, y: d.position.y, z: d.position.z });
      }
    }
  }
}
