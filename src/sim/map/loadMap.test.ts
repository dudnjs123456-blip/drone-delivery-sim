import { describe, expect, it } from 'vitest';
import rawMap from '../../data/map.json';
import { signedArea } from '../util/geometry';
import { loadMap, MapValidationError } from './loadMap';

const clone = () => structuredClone(rawMap) as unknown as ReturnType<typeof loadMap>;

describe('loadMap', () => {
  it('기본 map.json 은 검증을 통과하고 M1 요구사항을 만족한다', () => {
    const map = loadMap(rawMap);
    const apts = map.buildings.filter((b) => b.kind === 'APARTMENT');
    const coms = map.buildings.filter((b) => b.kind === 'COMMERCIAL');
    expect(apts.length).toBeGreaterThanOrEqual(10);
    expect(apts.length).toBeLessThanOrEqual(15);
    expect(coms.length).toBeGreaterThanOrEqual(2);
    expect(coms.length).toBeLessThanOrEqual(3);
    expect(map.stations.length).toBeGreaterThanOrEqual(1);
    expect(map.stations.length).toBeLessThanOrEqual(2);
    // 도크는 모두 상가 옥상
    for (const d of map.docks) {
      expect(map.buildings.find((b) => b.id === d.buildingId)?.kind).toBe('COMMERCIAL');
    }
  });

  it('시계 방향 footprint 를 반시계로 정규화한다', () => {
    const m = clone();
    m.buildings[0].footprint.reverse();
    expect(signedArea(m.buildings[0].footprint)).toBeLessThan(0);
    const loaded = loadMap(m);
    expect(signedArea(loaded.buildings[0].footprint)).toBeGreaterThan(0);
  });

  it('없는 건물을 참조하는 도크를 거부한다', () => {
    const m = clone();
    m.docks[0].buildingId = 'nope';
    expect(() => loadMap(m)).toThrow(MapValidationError);
  });

  it('옥상 높이와 다른 도크 z 를 거부한다', () => {
    const m = clone();
    m.docks[0].position.z += 5;
    expect(() => loadMap(m)).toThrow(/옥상 높이/);
  });

  it('건물 내부에 놓인 스테이션을 거부한다', () => {
    const m = clone();
    const [x, y] = m.buildings[0].footprint[0];
    m.stations[0].position = { x: x + 1, y: y + 1, z: 0 };
    expect(() => loadMap(m)).toThrow(/내부/);
  });

  it('id 중복을 거부한다', () => {
    const m = clone();
    m.buildings[1].id = m.buildings[0].id;
    expect(() => loadMap(m)).toThrow(/중복/);
  });
});
