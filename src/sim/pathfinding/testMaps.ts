/** 테스트용 작은 지도 */
import type { Building, MapData, NoFlyZone } from '../types';

export const rect = (cx: number, cy: number, w: number, d: number): [number, number][] => [
  [cx - w / 2, cy - d / 2],
  [cx + w / 2, cy - d / 2],
  [cx + w / 2, cy + d / 2],
  [cx - w / 2, cy + d / 2],
];

export function testMap(buildings: Partial<Building>[] = [], noFlyZones: NoFlyZone[] = [], half = 200): MapData {
  return {
    version: 1,
    origin: { lat: 0, lon: 0 },
    bounds: { minX: -half, minY: -half, maxX: half, maxY: half },
    buildings: buildings.map((b, i) => ({
      id: b.id ?? `b${i}`,
      kind: 'APARTMENT',
      footprint: b.footprint ?? rect(0, 0, 20, 20),
      heightM: b.heightM ?? 80,
    })),
    stores: [],
    docks: [],
    stations: [],
    noFlyZones,
  };
}
