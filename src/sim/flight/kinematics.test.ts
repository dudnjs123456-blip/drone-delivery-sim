import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../config';
import type { Vec3 } from '../types';
import { kmhToMs } from '../util/units';
import { type KinematicState, limitsFromConfig, maxSpeedAlong, stepAlongPath } from './kinematics';

const lim = limitsFromConfig(defaultConfig);
const DT = defaultConfig.time.fixedDtSec;
const EPS = 1e-6;

/** 경로 끝까지 시뮬레이션하며 매 스텝 제한 위반을 검사한다 */
function fly(waypoints: Vec3[], maxSec = 600) {
  const s: KinematicState = { position: { ...waypoints[0] }, velocity: { x: 0, y: 0, z: 0 } };
  let wp = 1;
  let t = 0;
  let maxH = 0;
  let maxUp = 0;
  let maxDown = 0;
  let maxAcc = 0;
  while (t < maxSec) {
    const v0 = { ...s.velocity };
    const r = stepAlongPath(s, waypoints, wp, lim, DT);
    wp = r.wpIndex;
    t += DT;
    const v = s.velocity;
    maxH = Math.max(maxH, Math.hypot(v.x, v.y));
    maxUp = Math.max(maxUp, v.z);
    maxDown = Math.max(maxDown, -v.z);
    if (!r.done) maxAcc = Math.max(maxAcc, Math.hypot(v.x - v0.x, v.y - v0.y, v.z - v0.z) / DT);
    if (r.done) return { done: true, t, s, maxH, maxUp, maxDown, maxAcc };
  }
  return { done: false, t, s, maxH, maxUp, maxDown, maxAcc };
}

describe('kinematics', () => {
  it('maxSpeedAlong: 축별 제한 중 가장 엄격한 값을 따른다', () => {
    expect(maxSpeedAlong({ x: 1, y: 0, z: 0 }, lim)).toBeCloseTo(kmhToMs(40));
    expect(maxSpeedAlong({ x: 0, y: 0, z: 1 }, lim)).toBeCloseTo(3);
    expect(maxSpeedAlong({ x: 0, y: 0, z: -1 }, lim)).toBeCloseTo(3);
    // 45° 상승: 수직 성분 3 m/s 가 먼저 걸린다
    const s = Math.SQRT1_2;
    expect(maxSpeedAlong({ x: s, y: 0, z: s }, lim)).toBeCloseTo(3 / s);
  });

  it('수직 이륙: 상승률·가속도 제한을 지키고 목표 고도에 정확히 멈춘다', () => {
    const r = fly([
      { x: 0, y: 0, z: 15 },
      { x: 0, y: 0, z: 60 },
    ]);
    expect(r.done).toBe(true);
    expect(r.s.position.z).toBe(60);
    expect(r.maxUp).toBeLessThanOrEqual(3 + EPS);
    expect(r.maxH).toBeLessThan(EPS);
    expect(r.maxAcc).toBeLessThanOrEqual(2 + EPS);
    // 45m 를 3m/s 로: 순수 상승 15s + 가감속·마무리 여유
    expect(r.t).toBeGreaterThan(15);
    expect(r.t).toBeLessThan(25);
  });

  it('수평 직선 순항: 40km/h 를 넘지 않고, 이론 시간에 가깝게 도착한다', () => {
    const L = 500;
    const r = fly([
      { x: 0, y: 0, z: 60 },
      { x: L, y: 0, z: 60 },
    ]);
    expect(r.done).toBe(true);
    expect(r.maxH).toBeLessThanOrEqual(kmhToMs(40) + EPS);
    expect(r.maxH).toBeGreaterThan(kmhToMs(40) - 0.01);
    expect(r.maxAcc).toBeLessThanOrEqual(2 + EPS);
    expect(Math.abs(r.s.position.z - 60)).toBeLessThan(EPS);
    const vmax = kmhToMs(40);
    const ideal = L / vmax + vmax / 2; // 최대 가속도로 가감속할 때의 최소 시간
    expect(r.t).toBeGreaterThan(ideal);
    expect(r.t).toBeLessThan(ideal + 10);
  });

  it('90° 꺾인 경로도 제한을 지키며 끝까지 간다', () => {
    const r = fly([
      { x: 0, y: 0, z: 60 },
      { x: 200, y: 0, z: 60 },
      { x: 200, y: 200, z: 60 },
    ]);
    expect(r.done).toBe(true);
    expect(r.s.position).toEqual({ x: 200, y: 200, z: 60 });
    expect(r.maxH).toBeLessThanOrEqual(kmhToMs(40) + EPS);
    expect(r.maxAcc).toBeLessThanOrEqual(2 + EPS);
  });

  it('하강 중 고도 변화가 있는 경로에서도 하강률 제한을 지킨다', () => {
    const r = fly([
      { x: 0, y: 0, z: 100 },
      { x: 20, y: 0, z: 10 },
    ]);
    expect(r.done).toBe(true);
    expect(r.maxDown).toBeLessThanOrEqual(3 + EPS);
  });
});
