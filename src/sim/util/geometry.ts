import type { Vec2Tuple } from '../types';

/** 신발끈 공식. 반시계 방향이면 양수 */
export function signedArea(poly: readonly Vec2Tuple[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/** 점이 다각형 내부에 있는지 (ray casting). 경계 위의 점은 결과가 일정하지 않다 */
export function pointInPolygon(x: number, y: number, poly: readonly Vec2Tuple[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polygonCentroid(poly: readonly Vec2Tuple[]): Vec2Tuple {
  const a = signedArea(poly);
  if (Math.abs(a) < 1e-9) {
    const sx = poly.reduce((s, p) => s + p[0], 0);
    const sy = poly.reduce((s, p) => s + p[1], 0);
    return [sx / poly.length, sy / poly.length];
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    const f = x1 * y2 - x2 * y1;
    cx += (x1 + x2) * f;
    cy += (y1 + y2) * f;
  }
  return [cx / (6 * a), cy / (6 * a)];
}
