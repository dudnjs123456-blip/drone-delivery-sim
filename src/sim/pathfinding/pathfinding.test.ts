import { describe, expect, it } from 'vitest';
import { type SimConfig, defaultConfig } from '../config';
import { defaultMap } from '../map/defaultMap';
import type { MapData, Vec3 } from '../types';
import { kmhToMs } from '../util/units';
import { astar, travelTime } from './astar';
import { findRouteConflicts } from './conflicts';
import { OccupancyGrid } from './grid';
import { ObstacleField, distanceToPolygon, obstacleParamsFromConfig } from './obstacles';
import { type PlannedRoute, PathPlanner } from './planner';
import { rect, testMap } from './testMaps';

const cfg = defaultConfig;
const pf = cfg.pathfinding;
const at = (x: number, y: number, z = cfg.altitude.cruiseM): Vec3 => ({ x, y, z });

function planOk(map: MapData, a: Vec3, b: Vec3, c: SimConfig = cfg): PlannedRoute {
  const r = new PathPlanner(map, c).plan(a, b);
  if (!r.ok) throw new Error(r.reason);
  return r;
}

/** 경로 위 모든 점이 건물 여유 거리를 지키는지 (샘플링) */
function minBuildingClearance(map: MapData, path: Vec3[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      const z = a.z + (b.z - a.z) * t;
      for (const bl of map.buildings) {
        if (z >= bl.heightM + pf.verticalClearanceM) continue;
        best = Math.min(best, distanceToPolygon(x, y, bl.footprint));
      }
    }
  }
  return best;
}

const pathLength = (p: Vec3[]) =>
  p.slice(1).reduce((s, q, i) => s + Math.hypot(q.x - p[i].x, q.y - p[i].y, q.z - p[i].z), 0);

describe('obstacles', () => {
  const field = new ObstacleField(testMap([{ footprint: rect(0, 0, 20, 20), heightM: 50 }]), obstacleParamsFromConfig(cfg));

  it('건물 여유 거리 안, 옥상 여유 이하이면 막힘', () => {
    expect(field.isBlocked(0, 0, 40)).toBe(true);
    expect(field.isBlocked(15, 0, 40)).toBe(true); // 벽에서 5m
    expect(field.isBlocked(25, 0, 40)).toBe(false); // 벽에서 15m
    expect(field.isBlocked(0, 0, 60)).toBe(false); // 옥상 50 + 여유 10
    expect(field.isBlocked(0, 0, 59)).toBe(true);
  });

  it('고도 제한과 지도 범위', () => {
    expect(field.isBlocked(100, 100, cfg.altitude.maxM)).toBe(false);
    expect(field.isBlocked(100, 100, cfg.altitude.maxM + 1)).toBe(true);
    expect(field.isBlocked(100, 100, pf.minAltitudeM - 1)).toBe(true);
    expect(field.isBlocked(500, 0, 60)).toBe(true);
  });

  it('비행금지구역 + 여유', () => {
    const f = new ObstacleField(
      testMap([], [{ id: 'z', center: { x: 0, y: 0 }, radiusM: 30, minZ: 0, maxZ: 150 }]),
      obstacleParamsFromConfig(cfg),
    );
    expect(f.isBlocked(32, 0, 60)).toBe(true); // 반경 30 + 여유 5
    expect(f.isBlocked(36, 0, 60)).toBe(false);
  });
});

describe('grid', () => {
  it('셀 중심 판정과 고도층', () => {
    const map = testMap([{ footprint: rect(0, 0, 20, 20), heightM: 50 }]);
    const g = new OccupancyGrid(map, new ObstacleField(map, obstacleParamsFromConfig(cfg)), 5, 10);
    expect(g.nz).toBe((cfg.altitude.maxM - pf.minAltitudeM) / 10 + 1);
    const c = g.cellAt(at(0, 0, 40));
    expect(g.isFree(c.i, c.j, c.k)).toBe(false);
    const top = g.cellAt(at(0, 0, 60));
    expect(g.isFree(top.i, top.j, top.k)).toBe(true);
    expect(g.center(top.i, top.j, top.k).z).toBe(60);
  });
});

describe('astar', () => {
  const cost = { horizSpeed: kmhToMs(40), climbRate: 3, descentRate: 3 };

  it('travelTime: 축별 제한 중 느린 쪽', () => {
    expect(travelTime(100, 0, cost)).toBeCloseTo(9);
    expect(travelTime(0, 30, cost)).toBeCloseTo(10);
    expect(travelTime(10, -30, cost)).toBeCloseTo(10);
  });

  it('막힘 없는 격자에서는 직선 거리 시간과 같다', () => {
    const map = testMap();
    const g = new OccupancyGrid(map, new ObstacleField(map, obstacleParamsFromConfig(cfg)), 5, 10);
    const s = g.cellAt(at(-100, 0));
    const t = g.cellAt(at(100, 0));
    const r = astar(g, s, t, cost)!;
    expect(r.cost).toBeCloseTo(200 / kmhToMs(40), 5);
  });

  it('막힌 목표에는 경로가 없다', () => {
    const map = testMap([{ footprint: rect(100, 0, 20, 20), heightM: 200 }]);
    const g = new OccupancyGrid(map, new ObstacleField(map, obstacleParamsFromConfig(cfg)), 5, 10);
    expect(astar(g, g.cellAt(at(-100, 0)), g.cellAt(at(100, 0)), cost)).toBeNull();
  });
});

describe('PathPlanner', () => {
  it('장애물이 없으면 직선 (탐색 생략)', () => {
    const r = planOk(testMap(), at(-100, 0), at(100, 0));
    expect(r.path).toHaveLength(2);
    expect(r.expanded).toBe(0);
  });

  it('고도 제한보다 높은 벽은 옆으로 돌아간다', () => {
    const map = testMap([{ footprint: rect(0, 0, 20, 200), heightM: 300 }]);
    const r = planOk(map, at(-100, 0), at(100, 0));
    expect(findRouteConflicts(map, r.path, cfg.altitude.maxM)).toEqual([]);
    expect(Math.max(...r.path.map((p) => p.z))).toBeLessThanOrEqual(cfg.altitude.maxM);
    expect(minBuildingClearance(map, r.path)).toBeGreaterThanOrEqual(pf.buildingClearanceM - 1e-6);
    expect(r.lengthM).toBeGreaterThan(200);
  });

  it('낮은 건물은 우회보다 넘어가는 편이 빠르면 넘어간다', () => {
    // 폭 300m(사실상 지도 전체)의 낮은 벽: 돌아가는 길이 없으니 넘어가야 한다
    const map = testMap([{ footprint: rect(0, 0, 20, 400), heightM: 55 }]);
    const r = planOk(map, at(-100, 0), at(100, 0));
    expect(Math.max(...r.path.map((p) => p.z))).toBeGreaterThanOrEqual(55 + pf.verticalClearanceM);
    expect(findRouteConflicts(map, r.path, cfg.altitude.maxM)).toEqual([]);
  });

  it('좁고 높은 건물 하나는 넘지 않고 옆으로 돌아간다 (시간이 더 짧음)', () => {
    const map = testMap([{ footprint: rect(0, 0, 20, 20), heightM: 120 }]);
    const r = planOk(map, at(-100, 0), at(100, 0));
    expect(Math.max(...r.path.map((p) => p.z))).toBe(cfg.altitude.cruiseM);
    expect(r.lengthM).toBeLessThan(230);
  });

  it('비행금지구역을 피한다', () => {
    const map = testMap([], [{ id: 'z', center: { x: 0, y: 0 }, radiusM: 40, minZ: 0, maxZ: 150 }]);
    const r = planOk(map, at(-100, 0), at(100, 0));
    expect(findRouteConflicts(map, r.path, cfg.altitude.maxM)).toEqual([]);
    for (const p of r.path) expect(Math.hypot(p.x, p.y)).toBeGreaterThanOrEqual(40);
  });

  it('도착점이 둘러싸여 있으면 실패를 알린다', () => {
    const map = testMap([], [{ id: 'z', center: { x: 100, y: 0 }, radiusM: 40, minZ: 0, maxZ: 150 }]);
    const r = new PathPlanner(map, cfg).plan(at(-100, 0), at(100, 0));
    expect(r.ok).toBe(false);
  });

  it('평활화 경로는 A* 격자 경로보다 웨이포인트가 적고 길지 않다', () => {
    const map = testMap([{ footprint: rect(0, 0, 20, 200), heightM: 300 }]);
    const r = planOk(map, at(-100, 0), at(100, 0));
    expect(r.path.length).toBeLessThan(r.rawPath.length);
    expect(pathLength(r.path)).toBeLessThanOrEqual(pathLength(r.rawPath) + 1e-6);
  });

  describe('기본 단지: 모든 도크 → 스테이션 조합', () => {
    const planner = new PathPlanner(defaultMap, cfg);
    for (const d of defaultMap.docks) {
      for (const s of defaultMap.stations) {
        it(`${d.id} → ${s.id}`, () => {
          const a = at(d.position.x, d.position.y);
          const b = at(s.position.x, s.position.y);
          const r = planner.plan(a, b);
          if (!r.ok) throw new Error(r.reason);
          expect(findRouteConflicts(defaultMap, r.path, cfg.altitude.maxM)).toEqual([]);
          expect(minBuildingClearance(defaultMap, r.path)).toBeGreaterThanOrEqual(pf.buildingClearanceM - 1e-6);
          for (const p of r.path) expect(p.z).toBeLessThanOrEqual(cfg.altitude.maxM);
          // 반대 방향도 경로가 있다 (복귀)
          expect(planner.plan(b, a).ok).toBe(true);
        });
      }
    }

    it('도크 A → 북측 스테이션은 비행금지구역을 돌아간다', () => {
      const d = defaultMap.docks.find((x) => x.id === 'dock-a')!;
      const s = defaultMap.stations.find((x) => x.id === 'station-n')!;
      const r = planner.plan(at(d.position.x, d.position.y), at(s.position.x, s.position.y));
      expect(r.ok && r.path.length).toBeGreaterThan(2);
    });
  });
});
