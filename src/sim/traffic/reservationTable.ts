/**
 * 시간-공간 예약 테이블.
 * 공간을 최소 이격 거리 크기(c)의 정육면체 셀로, 시간을 slotSec 칸으로 나눈다.
 * 각 드론은 시간 칸마다 "그 칸 동안 지나가는 모든 셀"을 예약한다.
 * 새 궤적은 같은 시간 칸에서 자기 셀의 26 이웃(+자기 자신)에 다른 드론의 예약이 없어야 한다.
 * → 두 드론의 셀이 서로 이웃이 아니면 어느 축으로든 한 칸(c) 이상 떨어져 있으므로 거리 ≥ c 가 보장된다.
 */
export interface TableBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/** 상대 시간 칸별로 지나가는 셀 키 목록 */
export type Footprint = number[][];

export class ReservationTable {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  private readonly slots = new Map<number, Map<number, string>>();
  private count = 0;

  constructor(
    private readonly b: TableBounds,
    readonly cellM: number,
  ) {
    this.nx = Math.ceil((b.maxX - b.minX) / cellM) + 1;
    this.ny = Math.ceil((b.maxY - b.minY) / cellM) + 1;
    this.nz = Math.ceil(b.maxZ / cellM) + 1;
  }

  cellKey(x: number, y: number, z: number): number {
    const c = this.cellM;
    const ix = clamp(Math.floor((x - this.b.minX) / c), this.nx);
    const iy = clamp(Math.floor((y - this.b.minY) / c), this.ny);
    const iz = clamp(Math.floor(z / c), this.nz);
    return (iz * this.ny + iy) * this.nx + ix;
  }

  /** baseSlot 부터 footprint 를 놓을 수 있는지 (다른 드론 예약과 이웃하지 않는지) */
  isFree(droneId: string, baseSlot: number, fp: Footprint): boolean {
    for (let s = 0; s < fp.length; s++) {
      const taken = this.slots.get(baseSlot + s);
      if (!taken || fp[s].length === 0) continue;
      for (const key of fp[s]) {
        if (this.neighborTaken(taken, key, droneId)) return false;
      }
    }
    return true;
  }

  reserve(droneId: string, baseSlot: number, fp: Footprint): void {
    for (let s = 0; s < fp.length; s++) {
      if (fp[s].length === 0) continue;
      let m = this.slots.get(baseSlot + s);
      if (!m) this.slots.set(baseSlot + s, (m = new Map()));
      for (const key of fp[s]) {
        if (!m.has(key)) this.count++;
        m.set(key, droneId);
      }
    }
  }

  /** fromSlot 이후 droneId 의 예약을 모두 지운다 (경로가 바뀐 경우) */
  release(droneId: string, fromSlot: number): void {
    for (const [s, m] of this.slots) {
      if (s < fromSlot) continue;
      for (const [k, owner] of m) {
        if (owner === droneId) {
          m.delete(k);
          this.count--;
        }
      }
      if (m.size === 0) this.slots.delete(s);
    }
  }

  /** beforeSlot 보다 이전 칸을 지운다 */
  prune(beforeSlot: number): void {
    for (const [s, m] of this.slots) {
      if (s < beforeSlot) {
        this.count -= m.size;
        this.slots.delete(s);
      }
    }
  }

  clear(): void {
    this.slots.clear();
    this.count = 0;
  }

  /** 예약된 (시간 칸, 셀) 쌍의 수 */
  get size(): number {
    return this.count;
  }

  private neighborTaken(taken: Map<number, string>, key: number, droneId: string): boolean {
    const nx = this.nx;
    const nxy = nx * this.ny;
    const ix = key % nx;
    const iy = Math.floor(key / nx) % this.ny;
    const iz = Math.floor(key / nxy);
    for (let dz = -1; dz <= 1; dz++) {
      const z = iz + dz;
      if (z < 0 || z >= this.nz) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const y = iy + dy;
        if (y < 0 || y >= this.ny) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const x = ix + dx;
          if (x < 0 || x >= nx) continue;
          const owner = taken.get(z * nxy + y * nx + x);
          if (owner !== undefined && owner !== droneId) return true;
        }
      }
    }
    return false;
  }
}

function clamp(v: number, n: number): number {
  return v < 0 ? 0 : v >= n ? n - 1 : v;
}
