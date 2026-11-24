/**
 * 도크·스테이션의 패드 배치. 엔진과 렌더링이 같은 함수를 쓴다.
 *
 * 도크: 옥상 긴 변을 따라 이착륙 패드(dock.pads 개)를 최대한 멀리(양 끝에서 10m 안쪽) 둔다.
 *       패드끼리 30m(최소 이격 거리 2배) 이상 떨어져야 동시에 이착륙할 수 있다.
 *       대기 드론은 옥상 가운데 격납고(dock.parking 칸)에 있고, 출발 때 패드로 옮겨진다.
 * 스테이션: 한 줄로 30m 간격.
 */
import type { Dock, MapData, Station, Vec3 } from '../types';
import { pointInPolygon } from '../util/geometry';

const ROOF_MARGIN_M = 10;
const PARKING_SPACING_M = 5;
const PARKING_COLS = 3;
export const STATION_PAD_SPACING_M = 30;
export const DEFAULT_PARKING = 9;

function roofOf(map: MapData, dock: Dock) {
  const roof = map.buildings.find((b) => b.id === dock.buildingId);
  if (!roof) throw new Error(`도크 ${dock.id}: 건물 ${dock.buildingId} 이 없습니다`);
  const xs = roof.footprint.map((p) => p[0]);
  const ys = roof.footprint.map((p) => p[1]);
  return { roof, w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

export function dockLaunchPads(map: MapData, dock: Dock): Vec3[] {
  const { roof, w, h } = roofOf(map, dock);
  const alongX = w >= h;
  const usable = Math.max(0, (alongX ? w : h) - 2 * ROOF_MARGIN_M);
  const n = dock.pads;
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const off = n === 1 ? 0 : -usable / 2 + (usable * i) / (n - 1);
    const p = { x: dock.position.x + (alongX ? off : 0), y: dock.position.y + (alongX ? 0 : off), z: dock.position.z };
    if (!pointInPolygon(p.x, p.y, roof.footprint)) throw new Error(`도크 ${dock.id}: 패드 ${i} 가 옥상 밖입니다`);
    out.push(p);
  }
  return out;
}

export function dockParking(map: MapData, dock: Dock): Vec3[] {
  const { roof } = roofOf(map, dock);
  const n = dock.parking ?? DEFAULT_PARKING;
  const rows = Math.ceil(n / PARKING_COLS);
  const out: Vec3[] = [];
  for (let k = 0; k < n; k++) {
    const c = k % PARKING_COLS;
    const r = Math.floor(k / PARKING_COLS);
    const p = {
      x: dock.position.x + (c - (PARKING_COLS - 1) / 2) * PARKING_SPACING_M,
      y: dock.position.y + (r - (rows - 1) / 2) * PARKING_SPACING_M,
      z: dock.position.z,
    };
    if (!pointInPolygon(p.x, p.y, roof.footprint)) throw new Error(`도크 ${dock.id}: 격납고 칸 ${k} 이 옥상 밖입니다`);
    out.push(p);
  }
  return out;
}

export function stationPads(station: Station): Vec3[] {
  return Array.from({ length: station.pads }, (_, i) => ({
    x: station.position.x + (i - (station.pads - 1) / 2) * STATION_PAD_SPACING_M,
    y: station.position.y,
    z: station.position.z,
  }));
}
