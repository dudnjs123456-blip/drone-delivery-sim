/** 돌발 장애물과 경로·위치의 기하 판정 */
import { distanceToPolygon } from '../pathfinding/obstacles';
import type { Building, NoFlyZone, Vec2Tuple, Vec3 } from '../types';
import type { HazardSpec } from './types';

/** 크레인 등 장애물 바닥 다각형 (정사각형) */
export function obstacleFootprint(spec: Extract<HazardSpec, { kind: 'OBSTACLE' }>): Vec2Tuple[] {
  const h = spec.sizeM / 2;
  const { x, y } = spec.center;
  return [
    [x - h, y - h],
    [x + h, y - h],
    [x + h, y + h],
    [x - h, y + h],
  ];
}

export function obstacleAsBuilding(id: string, spec: Extract<HazardSpec, { kind: 'OBSTACLE' }>): Building {
  return { id, kind: 'COMMERCIAL', name: '미등록 장애물', footprint: obstacleFootprint(spec), heightM: spec.heightM };
}

export function tfrAsZone(id: string, spec: Extract<HazardSpec, { kind: 'TFR' }>, maxZ: number): NoFlyZone {
  return { id, name: '임시 비행금지구역', center: spec.center, radiusM: spec.radiusM, minZ: 0, maxZ };
}

/** 점이 장애물 안(실제 충돌)인가 */
export function insideObstacle(p: Vec3, spec: Extract<HazardSpec, { kind: 'OBSTACLE' }>): boolean {
  return p.z < spec.heightM && distanceToPolygon(p.x, p.y, obstacleFootprint(spec)) === 0;
}

export function insideTfr(p: Vec3, spec: Extract<HazardSpec, { kind: 'TFR' }>): boolean {
  return Math.hypot(p.x - spec.center.x, p.y - spec.center.y) < spec.radiusM;
}

/** 장애물까지 수평 거리 (옥상 위로 충분히 높으면 Infinity) */
export function obstacleDistance(p: Vec3, spec: Extract<HazardSpec, { kind: 'OBSTACLE' }>, verticalMarginM: number): number {
  if (p.z >= spec.heightM + verticalMarginM) return Infinity;
  return distanceToPolygon(p.x, p.y, obstacleFootprint(spec));
}

/**
 * 폴리라인이 돌발 장애물(여유 포함)을 지나는가.
 * 경로 탐색 격자와 달리 최저 고도 제한을 보지 않아 이착륙 구간도 검사할 수 있다.
 */
export function pathHitsHazard(
  path: readonly Vec3[],
  spec: HazardSpec,
  marginM: number,
  verticalMarginM: number,
  sampleM = 2,
): boolean {
  if (spec.kind !== 'TFR' && spec.kind !== 'OBSTACLE') return false;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / sampleM));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
      if (spec.kind === 'TFR') {
        if (Math.hypot(p.x - spec.center.x, p.y - spec.center.y) < spec.radiusM + marginM) return true;
      } else if (obstacleDistance(p, spec, verticalMarginM) < marginM) {
        return true;
      }
    }
  }
  return false;
}

/** 침입기 위치: 시작점에서 방위(북=0, 시계)로 등속 직진 */
export function intruderPosition(spec: Extract<HazardSpec, { kind: 'INTRUDER' }>, elapsedSec: number): Vec3 {
  const h = (spec.headingDeg * Math.PI) / 180;
  const d = spec.speedMs * elapsedSec;
  return { x: spec.start.x + Math.sin(h) * d, y: spec.start.y + Math.cos(h) * d, z: spec.altitudeM };
}

export function intruderVelocity(spec: Extract<HazardSpec, { kind: 'INTRUDER' }>): Vec3 {
  const h = (spec.headingDeg * Math.PI) / 180;
  return { x: Math.sin(h) * spec.speedMs, y: Math.cos(h) * spec.speedMs, z: 0 };
}
