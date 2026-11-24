/**
 * 경로 계획기: 장애물 판정 → 3D 격자 → A* → 가시성 기반 평활화.
 * 지도·설정마다 한 번 만들어 재사용한다 (격자 생성이 가장 비싸다).
 */
import type { SimConfig } from '../config';
import type { MapData, Vec3 } from '../types';
import { kmhToMs } from '../util/units';
import { type TimeCostParams, astar, travelTime } from './astar';
import { OccupancyGrid } from './grid';
import { ObstacleField, obstacleParamsFromConfig } from './obstacles';

export interface PlannedRoute {
  /** 평활화된 경로 (start, ..., goal) */
  path: Vec3[];
  /** A* 격자 경로 (start, 셀 중심들..., goal) */
  rawPath: Vec3[];
  lengthM: number;
  /** 운동 제한만 고려한 최소 비행 시간 (가감속 제외) */
  estFlightSec: number;
  expanded: number;
  computeMs: number;
}

export type PlanResult = ({ ok: true } & PlannedRoute) | { ok: false; reason: string };

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class PathPlanner {
  readonly field: ObstacleField;
  readonly grid: OccupancyGrid;
  private readonly cost: TimeCostParams;
  private readonly losSampleM: number;

  constructor(map: MapData, cfg: SimConfig) {
    const pf = cfg.pathfinding;
    if ((cfg.altitude.cruiseM - pf.minAltitudeM) % pf.layerHeightM !== 0) {
      throw new Error('순항 고도는 격자 고도층 위에 있어야 합니다 (minAltitudeM + n·layerHeightM)');
    }
    this.field = new ObstacleField(map, obstacleParamsFromConfig(cfg));
    this.grid = new OccupancyGrid(map, this.field, pf.cellSizeM, pf.layerHeightM);
    this.cost = {
      horizSpeed: kmhToMs(cfg.drone.cruiseSpeedKmh),
      climbRate: cfg.drone.climbRateMs,
      descentRate: cfg.drone.descentRateMs,
    };
    this.losSampleM = pf.losSampleM;
  }

  plan(start: Vec3, goal: Vec3): PlanResult {
    const t0 = now();
    if (this.field.isBlocked(start.x, start.y, start.z)) return { ok: false, reason: '출발 지점 상공이 장애물 여유 안에 있습니다' };
    if (this.field.isBlocked(goal.x, goal.y, goal.z)) return { ok: false, reason: '도착 지점 상공이 장애물 여유 안에 있습니다' };

    // 직선으로 갈 수 있으면 탐색하지 않는다
    if (this.los(start, goal)) {
      return this.result([start, goal], [start, goal], 0, t0);
    }

    const g = this.grid;
    const s = g.nearestFree(g.cellAt(start));
    const t = g.nearestFree(g.cellAt(goal));
    if (!s || !t) return { ok: false, reason: '출발·도착 근처에 빈 격자가 없습니다' };

    const res = astar(g, s, t, this.cost);
    if (!res) return { ok: false, reason: '장애물을 피하는 경로를 찾지 못했습니다' };

    const raw = [start, ...res.cells.map((c) => {
      const { i, j, k } = g.cellOfIndex(c);
      return g.center(i, j, k);
    }), goal];
    return this.result(this.smooth(raw), raw, res.expanded, t0);
  }

  /**
   * 이미 계획한 경로의 양 끝만 가까운 다른 점(같은 도크의 다른 슬롯, 같은 스테이션의 다른 패드)으로 바꾼다.
   * 바뀐 첫·마지막 구간이 장애물에 막히면 null (그때는 새로 계획해야 한다).
   */
  reanchor(base: Extract<PlanResult, { ok: true }>, start: Vec3, goal: Vec3): PlanResult | null {
    const t0 = now();
    const mid = base.path.slice(1, -1);
    const path = [start, ...mid, goal];
    if (!this.los(path[0], path[1]) || !this.los(path[path.length - 2], path[path.length - 1])) return null;
    return this.result(path, base.rawPath, base.expanded, t0);
  }

  /** 앞에서부터 가장 멀리 보이는 점으로 건너뛰는 탐욕적 평활화 */
  smooth(pts: Vec3[]): Vec3[] {
    const out = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = i + 1;
      while (j + 1 < pts.length && this.los(pts[i], pts[j + 1])) j++;
      out.push(pts[j]);
      i = j;
    }
    return out;
  }

  private los(a: Vec3, b: Vec3): boolean {
    return this.field.lineOfSight(a.x, a.y, a.z, b.x, b.y, b.z, this.losSampleM);
  }

  private result(path: Vec3[], rawPath: Vec3[], expanded: number, t0: number): PlanResult {
    let lengthM = 0;
    let est = 0;
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i];
      const b = path[i + 1];
      const dh = Math.hypot(b.x - a.x, b.y - a.y);
      lengthM += Math.hypot(dh, b.z - a.z);
      est += travelTime(dh, b.z - a.z, this.cost);
    }
    return { ok: true, path, rawPath, lengthM, estFlightSec: est, expanded, computeMs: now() - t0 };
  }
}
