/**
 * 연속 공간의 장애물 판정. 격자 생성과 경로 평활화(가시성 검사)가 같은 판정을 쓴다.
 * - 건물: 바닥 다각형에서 수평 clearance 이내, 옥상 + verticalClearance 이하
 * - 비행금지구역: 반경 + margin 이내, [minZ - margin, maxZ + margin]
 * - 고도: minAltitude 미만 또는 maxAltitude 초과
 * - 지도 bounds 밖
 */
import type { SimConfig } from '../config';
import type { MapData, Vec2Tuple } from '../types';
import { pointInPolygon } from '../util/geometry';

export interface ObstacleParams {
  buildingClearanceM: number;
  verticalClearanceM: number;
  noFlyMarginM: number;
  minAltitudeM: number;
  maxAltitudeM: number;
}

export function obstacleParamsFromConfig(cfg: SimConfig): ObstacleParams {
  const p = cfg.pathfinding;
  return {
    buildingClearanceM: p.buildingClearanceM,
    verticalClearanceM: p.verticalClearanceM,
    noFlyMarginM: p.noFlyMarginM,
    minAltitudeM: p.minAltitudeM,
    maxAltitudeM: cfg.altitude.maxM,
  };
}

interface BuildingObstacle {
  footprint: Vec2Tuple[];
  topZ: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 점에서 다각형까지의 수평 거리 (내부면 0) */
export function distanceToPolygon(x: number, y: number, poly: readonly Vec2Tuple[]): number {
  if (pointInPolygon(x, y, poly)) return 0;
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j];
    const [bx, by] = poly[i];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
  }
  return best;
}

export class ObstacleField {
  private readonly buildings: BuildingObstacle[];
  private readonly zones: { cx: number; cy: number; r: number; minZ: number; maxZ: number }[];

  constructor(
    private readonly map: MapData,
    readonly params: ObstacleParams,
  ) {
    const c = params.buildingClearanceM;
    this.buildings = map.buildings.map((b) => {
      const xs = b.footprint.map((p) => p[0]);
      const ys = b.footprint.map((p) => p[1]);
      return {
        footprint: b.footprint,
        topZ: b.heightM + params.verticalClearanceM,
        minX: Math.min(...xs) - c,
        minY: Math.min(...ys) - c,
        maxX: Math.max(...xs) + c,
        maxY: Math.max(...ys) + c,
      };
    });
    const m = params.noFlyMarginM;
    this.zones = map.noFlyZones.map((z) => ({
      cx: z.center.x,
      cy: z.center.y,
      r: z.radiusM + m,
      minZ: z.minZ - m,
      maxZ: z.maxZ + m,
    }));
  }

  isBlocked(x: number, y: number, z: number): boolean {
    const p = this.params;
    if (z < p.minAltitudeM - 1e-6 || z > p.maxAltitudeM + 1e-6) return true;
    const { minX, minY, maxX, maxY } = this.map.bounds;
    if (x < minX || x > maxX || y < minY || y > maxY) return true;
    for (const b of this.buildings) {
      // 옥상 + 수직 여유와 같은 높이는 통과 가능 (여유를 정확히 지킨 것)
      if (z >= b.topZ || x < b.minX || x > b.maxX || y < b.minY || y > b.maxY) continue;
      if (distanceToPolygon(x, y, b.footprint) < p.buildingClearanceM) return true;
    }
    for (const zn of this.zones) {
      if (z < zn.minZ || z > zn.maxZ) continue;
      if (Math.hypot(x - zn.cx, y - zn.cy) < zn.r) return true;
    }
    return false;
  }

  /** a → b 직선이 장애물을 지나지 않는지 (sampleM 간격 샘플링) */
  lineOfSight(ax: number, ay: number, az: number, bx: number, by: number, bz: number, sampleM: number): boolean {
    const len = Math.hypot(bx - ax, by - ay, bz - az);
    const n = Math.max(1, Math.ceil(len / sampleM));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      if (this.isBlocked(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t)) return false;
    }
    return true;
  }
}
