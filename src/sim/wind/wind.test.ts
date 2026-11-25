import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../config';
import { LocalSimEngine } from '../engine/LocalSimEngine';
import { type KinematicState, limitsFromConfig, stepAlongPath } from '../flight/kinematics';
import { defaultMap } from '../map/defaultMap';
import type { Vec3 } from '../types';
import { kmhToMs } from '../util/units';
import { CALM, batteryCapacityFactor, meanWindAt, sensorFactor, wakeFactor, wakeZones, windToDir } from './weather';

const cfg = defaultConfig;
const DT = cfg.time.fixedDtSec;
const lim = limitsFromConfig(cfg);

describe('바람장', () => {
  it('고도가 높을수록 바람이 세다 (60m ≈ 10m 의 1.4~1.5배)', () => {
    const w = { ...CALM, windFromDeg: 270, windMeanMs: 5 };
    const at = (z: number) => Math.hypot(...Object.values(meanWindAt({ x: 0, y: -250, z }, w, [], cfg)).slice(0, 2));
    expect(at(10)).toBeCloseTo(5, 5);
    expect(at(60) / at(10)).toBeGreaterThan(1.4);
    expect(at(60) / at(10)).toBeLessThan(1.55);
  });

  it('서풍이면 바람은 동쪽으로 분다', () => {
    const d = windToDir(270);
    expect(d.x).toBeCloseTo(1);
    expect(d.y).toBeCloseTo(0);
  });

  it('높은 건물 뒤쪽(바람이 빠져나가는 쪽)은 빌딩풍으로 세지고, 앞쪽은 그대로', () => {
    const zones = wakeZones(defaultMap, 270, cfg);
    const b = defaultMap.buildings.find((x) => x.id === 'apt-113')!; // 105m, 중심 (-20,-60)
    expect(zones.some((z) => z.buildingId === b.id)).toBe(true);
    const behind = wakeFactor({ x: 10, y: -60, z: 40 }, zones, 270, cfg).speed;
    const front = wakeFactor({ x: -60, y: -60, z: 40 }, zones, 270, cfg).speed;
    expect(behind).toBeGreaterThan(1.3);
    expect(front).toBe(1);
  });

  it('비·안개는 센서 거리를, 추위는 배터리 용량을 줄인다', () => {
    expect(sensorFactor({ ...CALM, rainMmH: 10 }, cfg)).toBeLessThan(0.9);
    expect(sensorFactor({ ...CALM, visibilityM: 250 }, cfg)).toBeLessThan(0.3);
    expect(batteryCapacityFactor({ ...CALM, tempC: -10 }, cfg)).toBeCloseTo(0.7, 2);
    expect(batteryCapacityFactor(CALM, cfg)).toBe(1);
  });
});

describe('바람 속 비행 (대기 기준 운동)', () => {
  function fly(wind: Vec3, to: Vec3 = { x: 500, y: 0, z: 60 }) {
    const s: KinematicState = { position: { x: 0, y: 0, z: 60 }, velocity: { x: 0, y: 0, z: 0 } };
    const wps = [{ ...s.position }, to];
    let t = 0;
    let maxXt = 0;
    let maxGs = 0;
    let maxAir = 0;
    for (let i = 0; i < 20000; i++) {
      const r = stepAlongPath(s, wps, 1, lim, DT, wind);
      t += DT;
      maxXt = Math.max(maxXt, Math.abs(s.position.y));
      maxGs = Math.max(maxGs, Math.hypot(s.velocity.x, s.velocity.y));
      if (s.air) maxAir = Math.max(maxAir, Math.hypot(s.air.x, s.air.y));
      if (r.done) return { t, maxXt, maxGs, maxAir, s };
    }
    return { t: Infinity, maxXt, maxGs, maxAir, s };
  }
  const calm = fly({ x: 0, y: 0, z: 0 });

  it('맞바람 5m/s: 대기 속도는 40km/h 를 넘지 않고, 지면 속도가 줄어 더 오래 걸린다', () => {
    const r = fly({ x: -5, y: 0, z: 0 });
    expect(r.maxAir).toBeLessThanOrEqual(kmhToMs(40) + 1e-6);
    expect(r.maxGs).toBeLessThan(kmhToMs(40) - 4);
    expect(r.t).toBeGreaterThan(calm.t * 1.5);
  });

  it('옆바람 6m/s: 밀리지 않도록 보정하면서 목표에 도착한다', () => {
    const r = fly({ x: 0, y: 6, z: 0 });
    expect(r.t).toBeLessThan(Infinity);
    expect(r.maxXt).toBeLessThan(5);
    expect(r.s.position).toEqual({ x: 500, y: 0, z: 60 });
  });

  it('맞바람이 순항 속도보다 세면 대기 속도를 더 써서 최소 속도로라도 간다', () => {
    const r = fly({ x: -13, y: 0, z: 0 }, { x: 200, y: 0, z: 60 });
    expect(r.t).toBeLessThan(Infinity);
    expect(r.maxAir).toBeGreaterThan(kmhToMs(40));
    expect(r.maxAir).toBeLessThanOrEqual(kmhToMs(65) + 1e-6);
  });

  it('맞바람이 최대 대기 속도(65km/h)보다 세면 앞으로 가지 못한다 (운항 중단이 필요한 이유)', () => {
    const r = fly({ x: -20, y: 0, z: 0 }, { x: 200, y: 0, z: 60 });
    expect(r.t).toBe(Infinity);
  });
});

describe('엔진: 날씨 영향', () => {
  function flight(weather: Partial<typeof CALM>) {
    const e = new LocalSimEngine();
    e.load(defaultMap, cfg, 1);
    e.dispatch({ type: 'SET_WEATHER', weather, rampSec: 0 });
    e.step(DT);
    const r = e.dispatch({ type: 'FLY_MISSION', fromDockId: 'dock-c', toStationId: 'station-s' });
    if (!r.ok) throw new Error(r.reason);
    const d = e.getSnapshot().drones.find((x) => x.id === r.droneId)!;
    let sawEffect = false;
    let departed = false;
    let t = 0;
    for (let i = 0; i < 30000; i++) {
      e.step(DT);
      if (d.phase !== 'IDLE') departed = true;
      if (departed) t += DT;
      if (d.weather && d.weather.windMs > 0) sawEffect = true;
      if (departed && (d.phase === 'IDLE' || d.phase === 'FAILED')) break;
    }
    return { e, d, sawEffect, t };
  }

  it('바람이 불면 배터리를 더 쓰고 비행이 길어지며, 드론별 바람 영향이 기록된다', () => {
    const calm = flight({ windMeanMs: 0 });
    const windy = flight({ windFromDeg: 90, windMeanMs: 7, gustiness: 0.4 });
    expect(windy.d.phase).toBe('IDLE');
    expect(windy.sawEffect).toBe(true);
    expect(windy.d.battery).toBeLessThan(calm.d.battery);
    const st = windy.e.getSnapshot().weather.stats;
    expect(st.energyUsed / st.energyCalm).toBeGreaterThan(1.2);
    expect(st.windDelaySec).toBeGreaterThan(0);
  }, 30_000);

  it('추우면 같은 비행에도 배터리를 더 쓴다', () => {
    const warm = flight({ tempC: 15 });
    const cold = flight({ tempC: -10 });
    expect(1 - cold.d.battery).toBeGreaterThan((1 - warm.d.battery) * 1.3);
  }, 30_000);

  it('평균 12m/s 면 운항 중단: 드론이 뜨지 않고 주문은 라이더가 배송한다', () => {
    const e = new LocalSimEngine();
    e.load(defaultMap, cfg, 1);
    e.dispatch({ type: 'SET_FIRST_MILE_SCALE', scale: 0 });
    e.dispatch({ type: 'SET_WEATHER', weather: { windMeanMs: 12 }, rampSec: 0 });
    e.step(DT);
    expect(e.getSnapshot().weather.status.level).toBe('SUSPENDED');
    e.dispatch({ type: 'CREATE_ORDER', storeId: 'store-cafe', destBuildingId: 'apt-109' });
    for (let i = 0; i < 1500 / DT; i++) e.step(DT);
    const s = e.getSnapshot();
    const o = s.orders[0];
    expect(o.mode).toBe('RIDER');
    expect(o.status).toBe('DELIVERED');
    expect(s.drones.every((d) => d.phase === 'IDLE')).toBe(true);
    expect(s.weather.stats.riderOrders).toBe(1);
  }, 30_000);

  it('바람이 잦아들면 운항을 재개한다', () => {
    const e = new LocalSimEngine();
    e.load(defaultMap, cfg, 1);
    e.dispatch({ type: 'SET_WEATHER', weather: { windMeanMs: 12 }, rampSec: 0 });
    e.step(DT);
    e.dispatch({ type: 'SET_WEATHER', weather: { windMeanMs: 3 }, rampSec: 10 });
    for (let i = 0; i < 20 / DT; i++) e.step(DT);
    expect(e.getSnapshot().weather.status.level).toBe('OK');
    expect(e.getSnapshot().weather.stats.suspensions).toBe(1);
  });

  it('예보한 시각에 날씨가 바뀐다', () => {
    const e = new LocalSimEngine();
    e.load(defaultMap, cfg, 1);
    e.dispatch({ type: 'SCHEDULE_WEATHER', at: 30, weather: { ...CALM, windMeanMs: 8 }, label: '강풍' });
    for (let i = 0; i < 29 / DT; i++) e.step(DT);
    expect(e.getSnapshot().weather.mean10).toBe(0);
    for (let i = 0; i < (2 + cfg.wind.rampSec) / DT; i++) e.step(DT);
    expect(e.getSnapshot().weather.mean10).toBeCloseTo(8, 1);
  });

  it('바람 속 피크 운항에서도 예약 테이블이 이격을 지킨다', () => {
    const e = new LocalSimEngine();
    e.load(defaultMap, cfg, 3);
    e.dispatch({ type: 'SET_FIRST_MILE_SCALE', scale: 0 });
    e.dispatch({ type: 'SET_WEATHER', weather: { windFromDeg: 300, windMeanMs: 6, gustiness: 0.3 }, rampSec: 0 });
    e.dispatch({ type: 'SET_PEAK_MODE', ordersPerMin: 5 });
    for (let i = 0; i < 900 / DT; i++) e.step(DT);
    const s = e.getSnapshot();
    expect(s.orders.filter((o) => o.status === 'DELIVERED').length).toBeGreaterThan(20);
    expect(s.traffic.violationEvents).toBe(0);
  }, 120_000);
});
