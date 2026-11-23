import { describe, expect, it } from 'vitest';
import type { Vec2Tuple } from '../types';
import { pointInPolygon, polygonCentroid, signedArea } from './geometry';

const square: Vec2Tuple[] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

describe('geometry', () => {
  it('반시계 다각형의 면적은 양수, 시계 방향은 음수', () => {
    expect(signedArea(square)).toBe(100);
    expect(signedArea([...square].reverse())).toBe(-100);
  });

  it('pointInPolygon', () => {
    expect(pointInPolygon(5, 5, square)).toBe(true);
    expect(pointInPolygon(15, 5, square)).toBe(false);
    expect(pointInPolygon(-1, -1, square)).toBe(false);
  });

  it('L자형(오목) 다각형도 판정한다', () => {
    const L: Vec2Tuple[] = [
      [0, 0],
      [20, 0],
      [20, 10],
      [10, 10],
      [10, 20],
      [0, 20],
    ];
    expect(pointInPolygon(5, 15, L)).toBe(true);
    expect(pointInPolygon(15, 15, L)).toBe(false);
  });

  it('polygonCentroid', () => {
    expect(polygonCentroid(square)).toEqual([5, 5]);
  });
});
