/**
 * 비행 경로를 단계별 구간(leg)으로 나눈다.
 * TAKEOFF: 패드 → 바로 위 순항 고도 (수직)
 * CRUISE : 순항 고도에서 웨이포인트 추종
 * DESCEND: 목표 패드 상공 → 패드 (수직)
 * M2 에서는 순항 구간이 직선이고, M3 에서 A* 결과를 cruiseWaypoints 로 넣는다.
 */
import type { Vec3 } from '../types';
import { clone } from '../util/vec3';

export type LegKind = 'TAKEOFF' | 'CRUISE' | 'DESCEND';

export interface Leg {
  kind: LegKind;
  /** waypoints[0] 은 구간 시작점 */
  waypoints: Vec3[];
}

export function buildTripLegs(from: Vec3, to: Vec3, cruiseZ: number, cruiseWaypoints: Vec3[] = []): Leg[] {
  if (cruiseZ <= from.z || cruiseZ <= to.z) {
    throw new Error(`순항 고도(${cruiseZ}m)가 출발·도착 패드보다 높아야 합니다`);
  }
  const top = { x: from.x, y: from.y, z: cruiseZ };
  const above = { x: to.x, y: to.y, z: cruiseZ };
  return [
    { kind: 'TAKEOFF', waypoints: [clone(from), top] },
    { kind: 'CRUISE', waypoints: [clone(top), ...cruiseWaypoints.map(clone), above] },
    { kind: 'DESCEND', waypoints: [clone(above), clone(to)] },
  ];
}

/** 구간들을 이어 하나의 경로로 만든다. offsets[k] = k번째 구간 시작점의 경로 인덱스 */
export function flattenLegs(legs: readonly Leg[]): { path: Vec3[]; offsets: number[] } {
  const path: Vec3[] = [];
  const offsets: number[] = [];
  for (const leg of legs) {
    if (path.length === 0) {
      offsets.push(0);
      path.push(...leg.waypoints);
    } else {
      // 앞 구간의 끝점과 이번 구간의 시작점은 같은 점이다
      offsets.push(path.length - 1);
      path.push(...leg.waypoints.slice(1));
    }
  }
  return { path, offsets };
}
