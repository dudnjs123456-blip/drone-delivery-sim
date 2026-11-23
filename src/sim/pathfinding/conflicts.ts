/**
 * 경로(폴리라인)가 건물·비행금지구역·고도 제한을 침범하는지 검사한다.
 * M2 의 직선 경로 경고에 쓰고, M3 에서 A* 결과 검증에도 쓴다.
 */
import type { MapData, Vec3 } from '../types';
import { pointInPolygon } from '../util/geometry';

export type RouteConflict =
  | { kind: 'BUILDING'; id: string; name?: string; at: Vec3 }
  | { kind: 'NO_FLY'; id: string; name?: string; at: Vec3 }
  | { kind: 'ALTITUDE'; id: 'ceiling'; at: Vec3 };

/** 장애물마다 처음 침범한 지점 하나만 돌려준다 */
export function findRouteConflicts(map: MapData, path: readonly Vec3[], maxAltitudeM: number, sampleStepM = 2): RouteConflict[] {
  const found = new Map<string, RouteConflict>();
  const check = (p: Vec3) => {
    if (p.z > maxAltitudeM + 1e-6 && !found.has('ceiling')) found.set('ceiling', { kind: 'ALTITUDE', id: 'ceiling', at: { ...p } });
    for (const b of map.buildings) {
      if (found.has(b.id)) continue;
      // 옥상 면 위(z == heightM)는 침범이 아니다 (옥상 도크 이착륙)
      if (p.z < b.heightM - 1e-6 && pointInPolygon(p.x, p.y, b.footprint)) {
        found.set(b.id, { kind: 'BUILDING', id: b.id, name: b.name, at: { ...p } });
      }
    }
    for (const z of map.noFlyZones) {
      if (found.has(z.id)) continue;
      if (p.z >= z.minZ && p.z <= z.maxZ && Math.hypot(p.x - z.center.x, p.y - z.center.y) < z.radiusM) {
        found.set(z.id, { kind: 'NO_FLY', id: z.id, name: z.name, at: { ...p } });
      }
    }
  };

  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    const n = Math.max(1, Math.ceil(len / sampleStepM));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      check({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  return [...found.values()];
}
