import { describe, expect, it } from 'vitest';
import { type SimConfig, defaultConfig } from '../config';
import { defaultMap } from '../map/defaultMap';
import { dockParking, stationPads } from '../map/pads';
import { lastMissionDurations } from '../metrics/phaseDurations';
import { findRouteConflicts } from '../pathfinding/conflicts';
import type { Drone, FlightPhase, Vec3 } from '../types';
import { kmhToMs } from '../util/units';
import { LocalSimEngine } from './LocalSimEngine';
import type { SimEvent } from './SimEngine';

const DT = defaultConfig.time.fixedDtSec;
const EPS = 1e-6;

function cfgWith(patch: { fleet?: Partial<SimConfig['fleet']>; traffic?: Partial<SimConfig['traffic']> }): SimConfig {
  return {
    ...defaultConfig,
    fleet: { ...defaultConfig.fleet, ...patch.fleet },
    traffic: { ...defaultConfig.traffic, ...patch.traffic },
  };
}

/** 이 파일의 테스트는 교통·비행을 보므로 가게 공정(조리·포장·운반)은 즉시 처리한다 */
function makeEngine(cfg: SimConfig = defaultConfig, seed = 1) {
  const e = new LocalSimEngine();
  e.load(defaultMap, cfg, seed);
  e.dispatch({ type: 'SET_FIRST_MILE_SCALE', scale: 0 });
  return e;
}

const droneById = (e: LocalSimEngine, id: string) => e.getSnapshot().drones.find((d) => d.id === id)!;
const run = (e: LocalSimEngine, sec: number, each?: () => void) => {
  for (let i = 0; i < Math.round(sec / DT); i++) {
    e.step(DT);
    each?.();
  }
};

describe('LocalSimEngine: 드론 1대 비행', () => {
  it('도크에 순서대로 나눠 격납고 칸에 배치한다', () => {
    const e = makeEngine(cfgWith({ fleet: { droneCount: 4 } }));
    const ds = e.getSnapshot().drones;
    expect(ds.map((d) => d.homeDockId)).toEqual(['dock-a', 'dock-c', 'dock-a', 'dock-c']);
    const slotsA = dockParking(defaultMap, defaultMap.docks[0]);
    expect(ds[0].position).toEqual(slotsA[0]);
    expect(ds[2].position).toEqual(slotsA[1]);
  });

  it('왕복 임무: 상태 머신 순서, 운동 제한, 착륙 위치, 배터리, 구간 시간', () => {
    const e = makeEngine();
    const events: SimEvent[] = [];
    e.subscribe((ev) => events.push(ev));
    const res = e.dispatch({ type: 'FLY_MISSION', fromDockId: 'dock-c', toStationId: 'station-s' });
    expect(res.ok).toBe(true);
    const d = droneById(e, (res as { droneId: string }).droneId);
    const home = { ...d.position };
    const pads = stationPads(defaultMap.stations.find((s) => s.id === 'station-s')!);
    const vmax = kmhToMs(defaultConfig.drone.cruiseSpeedKmh);

    let maxH = 0;
    let maxAcc = 0;
    let maxZ = 0;
    let maxZOut = 0;
    let landedPos: Vec3 | null = null;
    let batteryAtLanding = -1;
    let batteryLastLanded = -1;
    let prev: FlightPhase = d.phase;
    let departed = false;
    for (let i = 0; i < 20000; i++) {
      const v0 = { ...d.velocity };
      e.step(DT);
      const v = d.velocity;
      maxH = Math.max(maxH, Math.hypot(v.x, v.y));
      maxAcc = Math.max(maxAcc, Math.hypot(v.x - v0.x, v.y - v0.y, v.z - v0.z) / DT);
      maxZ = Math.max(maxZ, d.position.z);
      if (!departed || d.phase === "TAKEOFF" || d.phase === "CRUISE" || d.phase === "DESCEND") maxZOut = Math.max(maxZOut, d.position.z);
      expect(v.z).toBeLessThanOrEqual(defaultConfig.drone.climbRateMs + EPS);
      expect(-v.z).toBeLessThanOrEqual(defaultConfig.drone.descentRateMs + EPS);
      if (d.phase === 'LANDED' && prev !== 'LANDED') {
        landedPos = { ...d.position };
        batteryAtLanding = d.battery;
      }
      if (d.phase === 'LANDED') batteryLastLanded = d.battery;
      if (d.phase !== 'IDLE') departed = true;
      prev = d.phase;
      if (departed && d.phase === 'IDLE') break;
    }

    const phases = events.filter((ev) => ev.type === 'PHASE_CHANGED' && ev.droneId === d.id).map((ev) => ev.type === 'PHASE_CHANGED' && ev.to);
    expect(phases).toEqual(['TAKEOFF', 'CRUISE', 'DESCEND', 'LANDED', 'RETURN', 'IDLE']);
    expect(maxH).toBeLessThanOrEqual(vmax + EPS);
    expect(maxAcc).toBeLessThanOrEqual(defaultConfig.drone.maxAccelMs2 + EPS);
    // 방향별 고도 분리: 편도 60m, 복귀 90m
    const [outAlt, backAlt] = defaultConfig.traffic.altitudePairsM[0];
    expect(maxZOut).toBeCloseTo(outAlt, 5);
    expect(maxZ).toBeCloseTo(backAlt, 5);
    expect(pads).toContainEqual(landedPos);
    expect(d.position).toEqual(home);
    expect(d.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(batteryLastLanded).toBeCloseTo(batteryAtLanding, 9);
    expect(d.battery).toBeLessThan(1);
    expect(d.battery).toBeGreaterThan(0.8);

    const m = lastMissionDurations(e.getSnapshot().phaseLog, d.id, e.getSnapshot().time)!;
    expect(m.phases.CRUISE).toBeGreaterThan(35);
    expect(m.phases.CRUISE).toBeLessThan(55);
    expect(m.phases.LANDED).toBeCloseTo(defaultConfig.drone.stationDwellSec, 1);
  });

  it('A* 경로로 날아간 실제 궤적은 장애물을 침범하지 않는다', () => {
    for (const [dockId, stationId] of [
      ['dock-a', 'station-n'],
      ['dock-a', 'station-s'],
    ] as const) {
      const e = makeEngine();
      const r = e.dispatch({ type: 'FLY_MISSION', fromDockId: dockId, toStationId: stationId });
      expect(r.ok).toBe(true);
      const d = droneById(e, (r as { droneId: string }).droneId);
      const flown: Vec3[] = [];
      let departed = false;
      run(e, 600, () => {
        if (d.phase !== 'IDLE') {
          departed = true;
          flown.push({ ...d.position });
        }
      });
      expect(departed).toBe(true);
      expect(d.phase).toBe('IDLE');
      expect(findRouteConflicts(defaultMap, flown, defaultConfig.altitude.maxM)).toEqual([]);
    }
  });

  it('과적과 다른 도크 소속 드론 지정을 거부한다', () => {
    const e = makeEngine();
    expect(e.dispatch({ type: 'FLY_MISSION', fromDockId: 'dock-a', toStationId: 'station-n', payloadKg: 5 }).ok).toBe(false);
    expect(e.dispatch({ type: 'FLY_MISSION', fromDockId: 'dock-a', toStationId: 'station-n', droneId: 'D02' }).ok).toBe(false);
  });

  it('reset 은 초기 상태로 되돌린다', () => {
    const e = makeEngine();
    e.dispatch({ type: 'CREATE_ORDER' });
    run(e, 60);
    e.reset();
    const s = e.getSnapshot();
    expect(s.time).toBe(0);
    expect(s.drones.every((d) => d.phase === 'IDLE')).toBe(true);
    expect(s.orders).toHaveLength(0);
    expect(s.phaseLog).toHaveLength(0);
    expect(s.traffic.reservedCells).toBe(0);
  });
});

describe('LocalSimEngine: 주문과 다중 드론', () => {
  it('주문은 가게의 도크 드론에 배정되고, 담당 스테이션으로 배송된다', () => {
    const e = makeEngine();
    const r = e.dispatch({ type: 'CREATE_ORDER', storeId: 'store-cafe', destBuildingId: 'apt-101' });
    expect(r.ok).toBe(true);
    const o = e.getSnapshot().orders[0];
    expect(o.status).toBe('KITCHEN_QUEUE');
    expect(o.stationId).toBe('station-n');
    run(e, 2);
    expect(o.droneId).not.toBeNull();
    const d = droneById(e, o.droneId!);
    expect(d.homeDockId).toBe('dock-c');
    run(e, 400);
    expect(o.status).toBe('DELIVERED');
    expect(o.t.takeoff).toBeGreaterThanOrEqual(o.t.assigned!);
    expect(o.t.delivered).toBeGreaterThan(o.t.takeoff!);
  });

  it('피크 모드는 설정한 비율 근처로 주문을 만든다', () => {
    const e = makeEngine();
    e.dispatch({ type: 'SET_PEAK_MODE', ordersPerMin: 6 });
    run(e, 600);
    const n = e.getSnapshot().orders.length;
    expect(n).toBeGreaterThan(40); // 기댓값 60
    expect(n).toBeLessThan(85);
  }, 30_000);

  it('같은 시드면 같은 시나리오가 재현된다', () => {
    const sig = (seed: number) => {
      const e = makeEngine(defaultConfig, seed);
      e.dispatch({ type: 'SET_PEAK_MODE', ordersPerMin: 4 });
      run(e, 300);
      return e.getSnapshot().orders.map((o) => `${o.storeId}>${o.destBuildingId}@${o.t.created.toFixed(2)}:${o.droneId}`).join(',');
    };
    expect(sig(7)).toBe(sig(7));
    expect(sig(7)).not.toBe(sig(8));
  }, 30_000);
});

describe('LocalSimEngine: 시간-공간 예약과 이격 거리', () => {
  /** 피크 부하로 돌리면서 최소 이격 거리(실측)와 위반 수를 잰다 */
  function stress(useReservations: boolean, perMin: number, sec: number) {
    const e = makeEngine(cfgWith({ traffic: { useReservations } }), 3);
    e.dispatch({ type: 'SET_PEAK_MODE', ordersPerMin: perMin });
    let maxAirborne = 0;
    let minDist = Infinity;
    run(e, sec, () => {
      const air = e.getSnapshot().drones.filter((d) => d.phase !== 'IDLE' && d.phase !== 'LANDED');
      maxAirborne = Math.max(maxAirborne, air.length);
      for (let i = 0; i < air.length; i++)
        for (let j = i + 1; j < air.length; j++) minDist = Math.min(minDist, dist(air[i], air[j]));
    });
    const s = e.getSnapshot();
    return { s, maxAirborne, minDist, delivered: s.orders.filter((o) => o.status === 'DELIVERED').length };
  }

  it('예약 테이블을 쓰면 드론 10대 이상이 동시에 날아도 15m 이격을 지킨다', () => {
    const r = stress(true, 8, 1200);
    expect(r.maxAirborne).toBeGreaterThanOrEqual(10);
    expect(r.minDist).toBeGreaterThanOrEqual(defaultConfig.traffic.minSeparationM);
    expect(r.s.traffic.violationEvents).toBe(0);
    expect(r.delivered).toBeGreaterThan(40);
    expect(r.s.traffic.missionsScheduled).toBeGreaterThan(40);
  }, 60_000);

  it('예약 테이블을 끄면 이격 위반이 생기고 경고 이벤트로 잡힌다', () => {
    const r = stress(false, 8, 600);
    expect(r.minDist).toBeLessThan(defaultConfig.traffic.minSeparationM);
    expect(r.s.traffic.violationEvents).toBeGreaterThan(0);
  }, 60_000);

  it('같은 도크에서 동시에 두 주문이 와도 출발을 시차·고도로 나눈다', () => {
    const e = makeEngine();
    e.dispatch({ type: 'CREATE_ORDER', storeId: 'store-chicken', destBuildingId: 'apt-102' });
    e.dispatch({ type: 'CREATE_ORDER', storeId: 'store-chicken', destBuildingId: 'apt-103' });
    run(e, 2);
    const ds = e.getSnapshot().drones.filter((d) => d.orderId);
    expect(ds).toHaveLength(2);
    const [a, b] = ds;
    // 같은 고도·같은 시각 출발은 불가능 (옥상 슬롯 간격 10m < 15m)
    expect(a.departAt === b.departAt && a.cruiseAltM === b.cruiseAltM).toBe(false);
  });
});

function dist(a: Drone, b: Drone) {
  return Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y, a.position.z - b.position.z);
}
