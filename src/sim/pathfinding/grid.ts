/**
 * 3D 점유 격자. 셀 중심이 ObstacleField 에서 막혀 있으면 막힌 셀이다.
 * 고도층 k 의 높이 = minZ + k·layerH (셀 "중심"이 정확히 그 고도에 있다).
 */
import type { MapData, Vec3 } from '../types';
import type { ObstacleField } from './obstacles';

export interface Cell {
  i: number;
  j: number;
  k: number;
}

export class OccupancyGrid {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly blocked: Uint8Array;

  constructor(
    map: MapData,
    readonly field: ObstacleField,
    readonly cell: number,
    readonly layerH: number,
  ) {
    const { minX, minY, maxX, maxY } = map.bounds;
    const { minAltitudeM, maxAltitudeM } = field.params;
    this.minX = minX;
    this.minY = minY;
    this.minZ = minAltitudeM;
    this.nx = Math.max(1, Math.floor((maxX - minX) / cell));
    this.ny = Math.max(1, Math.floor((maxY - minY) / cell));
    this.nz = Math.max(1, Math.floor((maxAltitudeM - minAltitudeM) / layerH + 1e-9) + 1);
    this.blocked = new Uint8Array(this.nx * this.ny * this.nz);
    for (let k = 0; k < this.nz; k++) {
      for (let j = 0; j < this.ny; j++) {
        for (let i = 0; i < this.nx; i++) {
          const c = this.center(i, j, k);
          if (field.isBlocked(c.x, c.y, c.z)) this.blocked[this.index(i, j, k)] = 1;
        }
      }
    }
  }

  get size(): number {
    return this.nx * this.ny * this.nz;
  }

  index(i: number, j: number, k: number): number {
    return (k * this.ny + j) * this.nx + i;
  }

  cellOfIndex(idx: number): Cell {
    const i = idx % this.nx;
    const j = Math.floor(idx / this.nx) % this.ny;
    const k = Math.floor(idx / (this.nx * this.ny));
    return { i, j, k };
  }

  center(i: number, j: number, k: number): Vec3 {
    return {
      x: this.minX + (i + 0.5) * this.cell,
      y: this.minY + (j + 0.5) * this.cell,
      z: this.minZ + k * this.layerH,
    };
  }

  inBounds(i: number, j: number, k: number): boolean {
    return i >= 0 && j >= 0 && k >= 0 && i < this.nx && j < this.ny && k < this.nz;
  }

  isFree(i: number, j: number, k: number): boolean {
    return this.inBounds(i, j, k) && this.blocked[this.index(i, j, k)] === 0;
  }

  /** 좌표가 속한 셀 (범위 밖이면 가장자리로 자른다) */
  cellAt(p: Vec3): Cell {
    const clamp = (v: number, n: number) => Math.min(n - 1, Math.max(0, v));
    return {
      i: clamp(Math.floor((p.x - this.minX) / this.cell), this.nx),
      j: clamp(Math.floor((p.y - this.minY) / this.cell), this.ny),
      k: clamp(Math.round((p.z - this.minZ) / this.layerH), this.nz),
    };
  }

  /** 같은 고도층에서 가장 가까운 빈 셀 (반경 maxRing 셀 이내) */
  nearestFree(c: Cell, maxRing = 4): Cell | null {
    if (this.isFree(c.i, c.j, c.k)) return c;
    for (let r = 1; r <= maxRing; r++) {
      let best: Cell | null = null;
      let bestD = Infinity;
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const i = c.i + di;
          const j = c.j + dj;
          if (!this.isFree(i, j, c.k)) continue;
          const d = di * di + dj * dj;
          if (d < bestD) {
            bestD = d;
            best = { i, j, k: c.k };
          }
        }
      }
      if (best) return best;
    }
    return null;
  }
}
