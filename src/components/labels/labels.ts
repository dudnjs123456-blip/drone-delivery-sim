/**
 * 3D 위치에 붙는 DOM 라벨.
 * LabelLayer(캔버스 밖 DOM)가 라벨을 그리고, LabelProjector(캔버스 안)가 매 프레임
 * 화면 좌표를 계산해 style.transform 만 갱신한다. React 리렌더 없이 위치가 따라간다.
 * 움직이는 라벨(dynamic)은 앵커를 소유한 컴포넌트가 labelAnchors 의 벡터를 매 프레임 갱신한다.
 */
import * as THREE from 'three';
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
  /** true 면 anchor 는 초기값이고, 이후 위치는 다른 컴포넌트가 labelAnchors 로 갱신한다 */
  dynamic?: boolean;
  /** 강조 표시 (굵은 테두리) */
  highlight?: boolean;
}

/** LabelLayer 가 등록하고 LabelProjector 가 읽는 DOM 요소 */
export const labelElements = new Map<string, HTMLElement>();
/** 라벨 id → 3D 앵커 (Three.js 좌표) */
export const labelAnchors = new Map<string, THREE.Vector3>();

/** 움직이는 라벨의 앵커를 갱신한다 (없으면 만든다) */
export function setLabelAnchor(id: string, x: number, y: number, z: number) {
  const v = labelAnchors.get(id);
  if (v) v.set(x, y, z);
  else labelAnchors.set(id, new THREE.Vector3(x, y, z));
}

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
