/**
 * 3D 위치에 붙는 DOM 라벨.
 * LabelLayer(캔버스 밖 DOM)가 라벨을 그리고, LabelProjector(캔버스 안)가 매 프레임
 * 화면 좌표를 계산해 style.transform 만 갱신한다. React 리렌더 없이 위치가 따라간다.
 */
import { defaultMap } from '@/sim/map/defaultMap';
import type { MapData } from '@/sim/types';
import { polygonCentroid } from '@/sim/util/geometry';
import { palette } from '../scene/palette';
import { type ThreeTuple, enuToThree } from '../coords';

export interface LabelSpec {
  id: string;
  text: string;
  sub?: string;
  /** 지정하면 색 배경 + 흰 글씨, 없으면 흰 배경 */
  color?: string;
  /** Three.js 좌표. 라벨의 아래쪽 가운데가 이 점에 붙는다 */
  anchor: ThreeTuple;
}

/** LabelLayer 가 등록하고 LabelProjector 가 읽는 DOM 요소 */
export const labelElements = new Map<string, HTMLElement>();

export function buildMapLabels(map: MapData): LabelSpec[] {
  const labels: LabelSpec[] = [];
  for (const b of map.buildings) {
    const [cx, cy] = polygonCentroid(b.footprint);
    labels.push({ id: b.id, text: b.name ?? b.id, sub: `${b.heightM}m`, anchor: enuToThree(cx, cy, b.heightM + 2) });
  }
  for (const d of map.docks) {
    labels.push({
      id: d.id,
      text: `🛫 ${d.name ?? d.id}`,
      sub: `${d.pads}패드`,
      color: palette.dock,
      anchor: enuToThree(d.position.x, d.position.y, d.position.z + 16),
    });
  }
  for (const s of map.stations) {
    labels.push({
      id: s.id,
      text: `🛬 ${s.name ?? s.id}`,
      sub: `배송원 ${s.couriers}명`,
      color: palette.station,
      anchor: enuToThree(s.position.x, s.position.y, s.position.z + 10),
    });
  }
  for (const s of map.stores) {
    labels.push({ id: s.id, text: s.name ?? s.id, color: palette.store, anchor: enuToThree(s.position.x, s.position.y, 8) });
  }
  for (const z of map.noFlyZones) {
    labels.push({
      id: z.id,
      text: `⛔ ${z.name ?? z.id}`,
      sub: `${z.minZ}~${z.maxZ}m`,
      color: palette.noFly,
      anchor: enuToThree(z.center.x, z.center.y, z.maxZ + 4),
    });
  }
  return labels;
}

// 지도는 정적이므로 라벨 목록도 한 번만 만든다 (DOM 레이어와 캔버스가 같은 배열을 공유)
export const defaultMapLabels = buildMapLabels(defaultMap);
