/**
 * 퍼스트 마일: 가게 주방(조리·포장) → 직원 운반(지상 → 엘리베이터 → 옥상) → 도크 적재 선반.
 * 상태는 엔진이 갖고, 이 파일은 상태 타입과 순수 계산(프로필, 운반 경로)만 둔다.
 */
import type { KitchenProfile, SimConfig } from '../config';
import type { Dock, MapData, Store, Vec2Tuple, Vec3 } from '../types';
import { pointInPolygon } from '../util/geometry';

export function kitchenProfile(cfg: SimConfig, storeId: string): KitchenProfile {
  return { ...cfg.kitchen.defaultProfile, ...cfg.kitchen.profiles[storeId] };
}

export interface KitchenJob {
  orderId: string;
  startStep: number;
  doneStep: number;
}

export interface KitchenState {
  storeId: string;
  dockId: string;
  /** 주방 대기 */
  queue: string[];
  cooking: KitchenJob[];
  packQueue: string[];
  packing: KitchenJob[];
  /** 포장 완료, 운반 대기 */
  ready: string[];
}

export type RunnerPhase = 'IDLE' | 'TO_DOCK' | 'BACK';

export interface RunnerState {
  id: string;
  storeId: string;
  dockId: string;
  phase: RunnerPhase;
  orderIds: string[];
  startStep: number;
  endStep: number;
}

/** 도크 옥상의 적재 선반 위치 (도크 중심에서 짧은 변 쪽으로) */
export function dockShelfPoint(map: MapData, dock: Dock): Vec3 {
  const roof = map.buildings.find((b) => b.id === dock.buildingId);
  for (const off of [-11, 11, -6, 6]) {
    const p = { x: dock.position.x, y: dock.position.y + off, z: dock.position.z };
    if (!roof || pointInPolygon(p.x, p.y, roof.footprint)) return p;
  }
  return { ...dock.position };
}

function nearestOnPolygon(x: number, y: number, poly: readonly Vec2Tuple[]): { x: number; y: number } {
  let best = { x: poly[0][0], y: poly[0][1] };
  let bestD = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j];
    const [bx, by] = poly[i];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
    const px = ax + t * dx;
    const py = ay + t * dy;
    const d = Math.hypot(x - px, y - py);
    if (d < bestD) {
      bestD = d;
      best = { x: px, y: py };
    }
  }
  return best;
}

/**
 * 직원 운반 경로: 가게 앞(지상) → 도크 건물 엘리베이터(지상) → 옥상 → 적재 선반.
 * 같은 건물이면 엘리베이터가 가게 바로 옆이다.
 */
export function runnerPath(map: MapData, store: Store): Vec3[] {
  const dock = map.docks.find((d) => d.id === store.dockId)!;
  const building = map.buildings.find((b) => b.id === dock.buildingId)!;
  const roofZ = dock.position.z;
  const start = { x: store.position.x, y: store.position.y, z: 0 };
  const base = nearestOnPolygon(start.x, start.y, building.footprint);
  const shelf = dockShelfPoint(map, dock);
  const pts: Vec3[] = [start, { ...base, z: 0 }, { ...base, z: roofZ }, shelf];
  // 길이가 0 인 구간은 뺀다
  return pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y, p.z - pts[i - 1].z) > 0.01);
}

/** 엘리베이터(수직) 구간은 같은 거리라도 걷기보다 오래 걸린다고 본다 */
const VERTICAL_WEIGHT = 3;

/** 경로를 따라 f(0~1) 만큼 간 위치 */
export function pointAlongRunnerPath(path: readonly Vec3[], f: number): Vec3 {
  if (path.length === 1) return { ...path[0] };
  const w: number[] = [];
  let total = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    const h = Math.hypot(b.x - a.x, b.y - a.y);
    const v = Math.abs(b.z - a.z);
    const seg = h + v * VERTICAL_WEIGHT;
    w.push(seg);
    total += seg;
  }
  let left = Math.min(1, Math.max(0, f)) * total;
  for (let i = 0; i < w.length; i++) {
    if (left <= w[i] || i === w.length - 1) {
      const t = w[i] > 0 ? Math.min(1, left / w[i]) : 1;
      const a = path[i];
      const b = path[i + 1];
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
    }
    left -= w[i];
  }
  return { ...path[path.length - 1] };
}
