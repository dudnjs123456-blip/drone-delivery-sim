import { describe, expect, it } from 'vitest';
import { type SimConfig, defaultConfig } from '../config';
import { defaultMap } from '../map/defaultMap';
import { lastMissionDurations } from '../metrics/phaseDurations';
import type { FlightPhase } from '../types';
import { kmhToMs } from '../util/units';
import { LocalSimEngine } from './LocalSimEngine';
import type { SimEvent } from './SimEngine';

const DT = defaultConfig.time.fixedDtSec;
const EPS = 1e-6;

function makeEngine(cfg: SimConfig = defaultConfig) {
  const e = new LocalSimEngine();
  e.load(defaultMap, cfg, 1);
  return e;
}

describe('LocalSimEngine', () => {
  it('도크 수만큼 순서대로 드론을 배치한다', () => {
    const e = makeEngine({ ...defaultConfig, fleet: { ...defaultConfig.fleet, droneCount: 3 } });
    const ds = e.getSnapshot().drones;
    expect(ds.map((d) => d.homeDockId)).toEqual(['dock-a', 'dock-c', 'dock-a']);
    expect(ds.every((d) => d.phase === 'IDLE')).toBe(true);
  });

  it('왕복 임무: 상태 머신 순서, 운동 제한, 착륙 위치, 배터리', () => {
    const e = makeEngine();
    const events: SimEvent[] = [];
    e.subscribe((ev) => events.push(ev));

    const res = e.dispatch({ type: 'FLY_MISSION', fromDockId: 'dock-c', toStationId: 'station-s' });
    expect(res.ok).toBe(true);

    const d = e.getSnapshot().drones[0];
    const station = defaultMap.stations.find((s) => s.id === 'station-s')!;
    const dock = defaultMap.docks.find((x) => x.id === 'dock-c')!;
    const vmax = kmhToMs(defaultConfig.drone.cruiseSpeedKmh);

    let maxH = 0;
    let maxAcc = 0;
    let maxZ = 0;
    let landedPos: { x: number; y: number; z: number } | null = null;
    let batteryAtLanding = -1;
    let batteryLeavingStation = -1;
    let prevPhase: FlightPhase = d.phase;

    for (let i = 0; i < 20000 && !(d.phase === 'IDLE' && i > 0); i++) {
      const v0 = { ...d.velocity };
      e.step(DT);
      const v = d.velocity;
      maxH = Math.max(maxH, Math.hypot(v.x, v.y));
      maxAcc = Math.max(maxAcc, Math.hypot(v.x - v0.x, v.y - v0.y, v.z - v0.z) / DT);
      maxZ = Math.max(maxZ, d.position.z);
      expect(v.z).toBeLessThanOrEqual(defaultConfig.drone.climbRateMs + EPS);
      expect(-v.z).toBeLessThanOrEqual(defaultConfig.drone.descentRateMs + EPS);
      if (d.phase === 'LANDED' && prevPhase !== 'LANDED') {
        landedPos = { ...d.position };
        batteryAtLanding = d.battery;
      }
      // 하역 대기 마지막 스텝의 배터리 (복귀를 시작한 스텝은 이미 비행 중이라 소모가 있다)
      if (d.phase === 'LANDED') batteryLeavingStation = d.battery;
      prevPhase = d.phase;
    }

    const phases = events.filter((ev) => ev.type === 'PHASE_CHANGED').map((ev) => ev.to);
    expect(phases).toEqual(['TAKEOFF', 'CRUISE', 'DESCEND', 'LANDED', 'RETURN', 'IDLE']);

    expect(maxH).toBeLessThanOrEqual(vmax + EPS);
    expect(maxAcc).toBeLessThanOrEqual(defaultConfig.drone.maxAccelMs2 + EPS);
    expect(maxZ).toBeLessThanOrEqual(defaultConfig.altitude.maxM);
    expect(maxZ).toBeCloseTo(defaultConfig.altitude.cruiseM, 5);

    expect(landedPos).toEqual(station.position);
    expect(d.position).toEqual(dock.position);
    expect(d.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(d.path).toEqual([]);
    expect(d.payloadKg).toBe(0);

    // 지상 대기 중에는 배터리가 줄지 않는다
    expect(batteryLeavingStation).toBeCloseTo(batteryAtLanding, 9);
    expect(d.battery).toBeLessThan(1);
    expect(d.battery).toBeGreaterThan(0.8);

    // 구간 시간: 수평 약 410m → 순항 40~55s, 하역 대기는 설정값
    const m = lastMissionDurations(e.getSnapshot().phaseLog, d.id, e.getSnapshot().time)!;
    expect(m.phases.CRUISE).toBeGreaterThan(40);
    expect(m.phases.CRUISE).toBeLessThan(55);
    expect(m.phases.LANDED).toBeCloseTo(defaultConfig.drone.stationDwellSec, 1);
    expect(m.outboundSec).toBeGreaterThan(m.phases.CRUISE!);
    expect(m.totalSec).toBeGreaterThan(m.outboundSec! + defaultConfig.drone.stationDwellSec);
  });

  it('비행 중인 드론에 다시 임무를 줄 수 없고, 과적을 거부한다', () => {
    const e = makeEngine();
    expect(e.dispatch({ type: 'FLY_MISSION', fromDockId: 'dock-a', toStationId: 'station-n', payloadKg: 5 }).ok).toBe(false);
    expect(e.dispatch({ type: 'FLY_MISSION', fromDockId: 'dock-a', toStationId: 'station-n' }).ok).toBe(true);
    e.step(DT);
    const again = e.dispatch({ type: 'FLY_MISSION', fromDockId: 'dock-a', toStationId: 'station-s' });
    expect(again.ok).toBe(false);
  });

  it('대기 중인 드론은 다른 도크로 옮겨 출발한다', () => {
    const e = makeEngine();
    const d = e.getSnapshot().drones[0];
    expect(d.homeDockId).toBe('dock-a');
    e.dispatch({ type: 'FLY_MISSION', fromDockId: 'dock-c', toStationId: 'station-s' });
    expect(d.homeDockId).toBe('dock-c');
    expect(d.position).toEqual(defaultMap.docks.find((x) => x.id === 'dock-c')!.position);
  });

  it('reset 은 초기 상태로 되돌린다', () => {
    const e = makeEngine();
    e.dispatch({ type: 'FLY_MISSION', fromDockId: 'dock-a', toStationId: 'station-n' });
    for (let i = 0; i < 200; i++) e.step(DT);
    e.reset();
    const s = e.getSnapshot();
    expect(s.time).toBe(0);
    expect(s.drones[0].phase).toBe('IDLE');
    expect(s.phaseLog).toHaveLength(0);
  });
});
