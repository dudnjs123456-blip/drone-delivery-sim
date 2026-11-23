import { describe, expect, it } from 'vitest';
import { buildTripLegs, flattenLegs } from '../flight/route';
import { defaultMap } from '../map/defaultMap';
import { findRouteConflicts } from './conflicts';

const pos = (id: string) =>
  [...defaultMap.docks, ...defaultMap.stations].find((p) => p.id === id)!.position;
const straight = (from: string, to: string, z = 60) => flattenLegs(buildTripLegs(pos(from), pos(to), z)).path;

describe('findRouteConflicts', () => {
  it('도크 C → 남측 스테이션 직선 경로는 장애물이 없다', () => {
    expect(findRouteConflicts(defaultMap, straight('dock-c', 'station-s'), 150)).toEqual([]);
  });

  it('도크 A → 북측 스테이션 직선 경로는 비행금지구역을 지난다', () => {
    const c = findRouteConflicts(defaultMap, straight('dock-a', 'station-n'), 150);
    expect(c.map((x) => x.id)).toEqual(['nfz-1']);
  });

  it('도크 A → 남측 스테이션 직선 경로는 106동(72m)과 부딪힌다', () => {
    const c = findRouteConflicts(defaultMap, straight('dock-a', 'station-s'), 150);
    expect(c.some((x) => x.kind === 'BUILDING' && x.id === 'apt-106')).toBe(true);
  });

  it('고도 제한 초과를 잡아낸다', () => {
    const c = findRouteConflicts(defaultMap, straight('dock-c', 'station-s', 160), 150);
    expect(c.some((x) => x.kind === 'ALTITUDE')).toBe(true);
  });
});
