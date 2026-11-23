/**
 * 3D 격자 A*. 26방향 이웃, 비용은 "비행 시간".
 * 한 구간의 시간 = max(수평거리/순항속도, 상승고도/상승률, 하강고도/하강률)
 * (운동 모델이 축별 제한을 동시에 적용하므로). 휴리스틱도 같은 식이라 허용적(admissible)이다.
 */
import type { Cell, OccupancyGrid } from './grid';

export interface TimeCostParams {
  horizSpeed: number;
  climbRate: number;
  descentRate: number;
}

export interface AStarResult {
  /** 시작 → 목표 셀 인덱스 */
  cells: number[];
  /** 추정 비행 시간 (s) */
  cost: number;
  expanded: number;
}

/** 수평 dh, 수직 dz 를 이동하는 데 걸리는 최소 시간 */
export function travelTime(dh: number, dz: number, p: TimeCostParams): number {
  const th = dh / p.horizSpeed;
  const tv = dz >= 0 ? dz / p.climbRate : -dz / p.descentRate;
  return th > tv ? th : tv;
}

const NEIGHBORS: [number, number, number][] = [];
for (let dk = -1; dk <= 1; dk++)
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if (di || dj || dk) NEIGHBORS.push([di, dj, dk]);

/** 최소 힙 (f 값 기준) */
class MinHeap {
  private idx: number[] = [];
  private f: number[] = [];
  get size() {
    return this.idx.length;
  }
  push(i: number, f: number) {
    const a = this.idx;
    const b = this.f;
    a.push(i);
    b.push(f);
    let n = a.length - 1;
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (b[p] <= b[n]) break;
      [a[p], a[n]] = [a[n], a[p]];
      [b[p], b[n]] = [b[n], b[p]];
      n = p;
    }
  }
  pop(): number {
    const a = this.idx;
    const b = this.f;
    const top = a[0];
    const lastI = a.pop()!;
    const lastF = b.pop()!;
    if (a.length > 0) {
      a[0] = lastI;
      b[0] = lastF;
      let n = 0;
      for (;;) {
        const l = 2 * n + 1;
        const r = l + 1;
        let m = n;
        if (l < a.length && b[l] < b[m]) m = l;
        if (r < a.length && b[r] < b[m]) m = r;
        if (m === n) break;
        [a[m], a[n]] = [a[n], a[m]];
        [b[m], b[n]] = [b[n], b[m]];
        n = m;
      }
    }
    return top;
  }
}

export function astar(grid: OccupancyGrid, start: Cell, goal: Cell, p: TimeCostParams): AStarResult | null {
  if (!grid.isFree(start.i, start.j, start.k) || !grid.isFree(goal.i, goal.j, goal.k)) return null;
  const N = grid.size;
  const g = new Float64Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const heap = new MinHeap();
  const { cell, layerH, nx, ny } = grid;

  const h = (i: number, j: number, k: number) =>
    travelTime(Math.hypot(goal.i - i, goal.j - j) * cell, (goal.k - k) * layerH, p);

  const s = grid.index(start.i, start.j, start.k);
  const t = grid.index(goal.i, goal.j, goal.k);
  g[s] = 0;
  heap.push(s, h(start.i, start.j, start.k));
  let expanded = 0;

  while (heap.size > 0) {
    const cur = heap.pop();
    if (closed[cur]) continue;
    if (cur === t) {
      const cells: number[] = [];
      for (let c = t; c !== -1; c = came[c]) cells.push(c);
      cells.reverse();
      return { cells, cost: g[t], expanded };
    }
    closed[cur] = 1;
    expanded++;
    const ci = cur % nx;
    const cj = Math.floor(cur / nx) % ny;
    const ck = Math.floor(cur / (nx * ny));
    for (const [di, dj, dk] of NEIGHBORS) {
      const i = ci + di;
      const j = cj + dj;
      const k = ck + dk;
      if (!grid.inBounds(i, j, k)) continue;
      const n = grid.index(i, j, k);
      if (closed[n] || grid.blocked[n]) continue;
      // 대각 이동이 막힌 셀의 모서리를 자르지 않도록, 수평 대각선은 양옆 셀도 비어 있어야 한다
      if (di && dj && (grid.blocked[grid.index(ci + di, cj, ck)] || grid.blocked[grid.index(ci, cj + dj, ck)])) continue;
      const ng = g[cur] + travelTime(Math.hypot(di, dj) * cell, dk * layerH, p);
      if (ng < g[n]) {
        g[n] = ng;
        came[n] = cur;
        heap.push(n, ng + h(i, j, k));
      }
    }
  }
  return null;
}
