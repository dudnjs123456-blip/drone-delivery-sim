import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../config';
import type { Drone } from '../types';
import type { SimEngine, SimSnapshot } from './SimEngine';
import { SimRunner } from './SimRunner';

/** 스텝 수를 세고, 매 스텝 x 를 1 늘리는 가짜 엔진 */
function fakeEngine() {
  const drone = { id: 'D01', position: { x: 0, y: 0, z: 0 } } as Drone;
  const snap = { time: 0, drones: [drone], orders: [], wind: { fromDirRad: 0, meanSpeed: 0, gustSpeed: 0 }, activeAlerts: [], phaseLog: [] } as unknown as SimSnapshot;
  const e = {
    steps: 0,
    load() {},
    step(dt: number) {
      e.steps++;
      snap.time += dt;
      drone.position.x += 1;
    },
    getSnapshot: () => snap,
    dispatch: () => ({ ok: true as const }),
    subscribe: () => () => {},
    reset() {
      e.steps = 0;
      snap.time = 0;
      drone.position.x = 0;
    },
  };
  return { e: e as SimEngine & { steps: number }, drone, snap };
}

describe('SimRunner', () => {
  it('1x: 실제 1초에 50ms 스텝 20번', () => {
    const { e, snap } = fakeEngine();
    const r = new SimRunner(e, defaultConfig.time);
    for (let i = 0; i < 60; i++) r.advance(1 / 60);
    expect(e.steps).toBeGreaterThanOrEqual(19);
    expect(e.steps).toBeLessThanOrEqual(20);
    expect(snap.time).toBeCloseTo(e.steps * 0.05);
  });

  it('20x: 실제 1초에 시뮬레이션 20초', () => {
    const { e, snap } = fakeEngine();
    const r = new SimRunner(e, defaultConfig.time);
    r.speed = 20;
    for (let i = 0; i < 60; i++) r.advance(1 / 60);
    expect(snap.time).toBeGreaterThan(19.9);
    expect(snap.time).toBeLessThanOrEqual(20.0001);
  });

  it('일시정지 중에는 진행하지 않는다', () => {
    const { e } = fakeEngine();
    const r = new SimRunner(e, defaultConfig.time);
    r.paused = true;
    r.advance(1);
    expect(e.steps).toBe(0);
  });

  it('긴 프레임은 잘라서 폭주하지 않는다', () => {
    const { e } = fakeEngine();
    const r = new SimRunner(e, { ...defaultConfig.time, maxStepsPerFrame: 10 });
    r.speed = 20;
    expect(r.advance(10)).toBe(10);
    expect(r.alpha).toBe(0);
  });

  it('보간 위치는 직전·현재 스텝 사이에 있다', () => {
    const { e, drone } = fakeEngine();
    const r = new SimRunner(e, defaultConfig.time);
    r.advance(0.075); // 1스텝 + 절반
    expect(drone.position.x).toBe(1);
    expect(r.alpha).toBeCloseTo(0.5);
    expect(r.interpolatedPosition(drone).x).toBeCloseTo(0.5);
  });
});
