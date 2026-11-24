import type { Drone } from '../types';

export interface SeparationPair {
  a: string;
  b: string;
  distM: number;
}

/** 비행 중 드론 쌍 중 최소 이격 거리보다 가까운 쌍 */
export function findSeparationViolations(airborne: readonly Drone[], minSepM: number): SeparationPair[] {
  const out: SeparationPair[] = [];
  for (let i = 0; i < airborne.length; i++) {
    const p = airborne[i].position;
    for (let j = i + 1; j < airborne.length; j++) {
      const q = airborne[j].position;
      const d = Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
      if (d < minSepM) out.push({ a: airborne[i].id, b: airborne[j].id, distM: d });
    }
  }
  return out;
}
