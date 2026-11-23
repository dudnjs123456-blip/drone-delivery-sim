/**
 * map.json 을 검증하고 MapData 로 정규화한다.
 * 브이월드 등 다른 데이터 소스로 교체할 때도 최종적으로 이 형태를 거치게 한다.
 */
import type { Building, MapData, Vec2Tuple } from '../types';
import { pointInPolygon, signedArea } from '../util/geometry';

export class MapValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(`map 데이터 오류 ${problems.length}건:\n- ${problems.join('\n- ')}`);
    this.name = 'MapValidationError';
  }
}

const ROOF_TOLERANCE_M = 0.5;

export function loadMap(raw: unknown): MapData {
  const map = raw as MapData;
  const problems: string[] = [];

  if (!map || typeof map !== 'object') throw new MapValidationError(['map 이 객체가 아닙니다']);
  if (map.version !== 1) problems.push(`지원하지 않는 version: ${String(map.version)}`);
  for (const key of ['buildings', 'stores', 'docks', 'stations', 'noFlyZones'] as const) {
    if (!Array.isArray(map[key])) problems.push(`${key} 배열이 없습니다`);
  }
  if (problems.length) throw new MapValidationError(problems);

  // id 중복 검사 (모든 엔티티 공통 네임스페이스)
  const seen = new Set<string>();
  const all = [...map.buildings, ...map.stores, ...map.docks, ...map.stations, ...map.noFlyZones];
  for (const e of all) {
    if (seen.has(e.id)) problems.push(`id 중복: ${e.id}`);
    seen.add(e.id);
  }

  const buildingById = new Map(map.buildings.map((b) => [b.id, b]));
  const dockIds = new Set(map.docks.map((d) => d.id));

  const buildings: Building[] = map.buildings.map((b) => {
    if (!Array.isArray(b.footprint) || b.footprint.length < 3) {
      problems.push(`건물 ${b.id}: footprint 꼭짓점이 3개 미만`);
      return b;
    }
    if (!(b.heightM > 0)) problems.push(`건물 ${b.id}: heightM 이 0 이하`);
    const area = signedArea(b.footprint);
    if (Math.abs(area) < 1) problems.push(`건물 ${b.id}: footprint 면적이 0`);
    // 시계 방향이면 반시계로 뒤집는다
    const footprint: Vec2Tuple[] = area < 0 ? [...b.footprint].reverse() : b.footprint;
    return { ...b, footprint };
  });

  for (const d of map.docks) {
    const b = buildingById.get(d.buildingId);
    if (!b) {
      problems.push(`도크 ${d.id}: 없는 건물 ${d.buildingId}`);
      continue;
    }
    if (!pointInPolygon(d.position.x, d.position.y, b.footprint))
      problems.push(`도크 ${d.id}: 건물 ${b.id} 옥상 밖에 있습니다`);
    if (Math.abs(d.position.z - b.heightM) > ROOF_TOLERANCE_M)
      problems.push(`도크 ${d.id}: z(${d.position.z})가 옥상 높이(${b.heightM})와 다릅니다`);
  }

  for (const s of map.stores) {
    if (!buildingById.has(s.buildingId)) problems.push(`가게 ${s.id}: 없는 건물 ${s.buildingId}`);
    if (!dockIds.has(s.dockId)) problems.push(`가게 ${s.id}: 없는 도크 ${s.dockId}`);
    if (!(s.walkToDockSec >= 0)) problems.push(`가게 ${s.id}: walkToDockSec 가 음수`);
  }

  for (const st of map.stations) {
    for (const bid of st.servesBuildingIds) {
      if (!buildingById.has(bid)) problems.push(`스테이션 ${st.id}: 없는 건물 ${bid}`);
    }
    for (const b of buildings) {
      if (b.footprint.length >= 3 && pointInPolygon(st.position.x, st.position.y, b.footprint))
        problems.push(`스테이션 ${st.id}: 건물 ${b.id} 내부에 있습니다`);
    }
  }

  for (const z of map.noFlyZones) {
    if (!(z.radiusM > 0)) problems.push(`비행금지구역 ${z.id}: radiusM 이 0 이하`);
    if (!(z.maxZ > z.minZ)) problems.push(`비행금지구역 ${z.id}: maxZ <= minZ`);
  }

  const { minX, minY, maxX, maxY } = map.bounds;
  const inBounds = (x: number, y: number) => x >= minX && x <= maxX && y >= minY && y <= maxY;
  for (const b of buildings) {
    if (b.footprint.some(([x, y]) => !inBounds(x, y))) problems.push(`건물 ${b.id}: bounds 밖`);
  }
  for (const p of [...map.docks, ...map.stations, ...map.stores]) {
    if (!inBounds(p.position.x, p.position.y)) problems.push(`${p.id}: bounds 밖`);
  }

  if (problems.length) throw new MapValidationError(problems);
  return { ...map, buildings };
}
