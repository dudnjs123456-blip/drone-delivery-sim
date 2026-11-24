import { describe, expect, it } from 'vitest';
import { type SimConfig, defaultConfig } from '../config';
import { LocalSimEngine } from '../engine/LocalSimEngine';
import type { SimEvent } from '../engine/SimEngine';
import { defaultMap } from '../map/defaultMap';
import { stationPads } from '../map/pads';
import type { Drone, FlightPhase, Vec3 } from '../types';
import type { HazardSpec, ResponsePolicies } from './types';

const DT = defaultConfig.time.fixedDtSec;

interface Scenario {
  e: LocalSimEngine;
  d: Drone;
  phases: FlightPhase[];
  landedAt: Vec3[];
  run: (sec: number, until?: () => boolean) => void;
}

/** 도크 C → 남측 스테이션(직선 경로) 시험 비행을 띄우고 순항에 들어갈 때까지 진행 */
function launch(policies: Partial<ResponsePolicies> = {}, cfg: SimConfig = defaultConfig, to = 'station-s'): Scenario {
  const e = new LocalSimEngine();
  e.load(defaultMap, cfg, 1);
  e.dispatch({ type: 'SET_POLICIES', policies });
  const r = e.dispatch({ type: 'FLY_MISSION', fromDockId: 'dock-c', toStationId: to });
  if (!r.ok) throw new Error(r.reason);
  const d = e.getSnapshot().drones.find((x) => x.id === r.droneId)!;
  const phases: FlightPhase[] = [];
  const landedAt: Vec3[] = [];
  e.subscribe((ev: SimEvent) => {
    if (ev.type === 'PHASE_CHANGED' && ev.droneId === d.id) {
      phases.push(ev.to);
      if (ev.to === 'LANDED') landedAt.push({ ...d.position });
    }
  });
  const run = (sec: number, until?: () => boolean) => {
    for (let i = 0; i < Math.round(sec / DT); i++) {
      e.step(DT);
      if (until?.()) return;
    }
  };
  run(120, () => d.phase === 'CRUISE');
  run(3);
  return { e, d, phases, landedAt, run };
}

/** 드론 진행 방향으로 dist 만큼 앞 (수평) */
function ahead(d: Drone, dist: number): { x: number; y: number } {
  return { x: d.position.x + Math.sin(d.headingRad) * dist, y: d.position.y + Math.cos(d.headingRad) * dist };
}

const inject = (s: Scenario, spec: HazardSpec, atSec?: number) => {
  const r = s.e.dispatch({ type: 'INJECT_HAZARD', spec, atSec });
  if (!r.ok) throw new Error(r.reason);
  return r.hazardId!;
};
const safety = (s: Scenario) => s.e.getSnapshot().safety;
const untilIdleOrFailed = (s: Scenario) => s.run(900, () => s.d.phase === 'IDLE' || s.d.phase === 'FAILED');

describe('임시 비행금지구역 (UTM 방송)', () => {
  const tfr = (s: Scenario): HazardSpec => ({ kind: 'TFR', center: ahead(s.d, 150), radiusM: 50, durationSec: null });

  it('재경로: 침범 없이 우회해 배송하고 돌아온다', () => {
    const s = launch({ TFR: 'REROUTE' });
    inject(s, tfr(s));
    untilIdleOrFailed(s);
    expect(s.d.phase).toBe('IDLE');
    expect(safety(s).tfrIncursions).toBe(0);
    expect(safety(s).reroutes).toBeGreaterThanOrEqual(1);
    expect(s.phases).toContain('LANDED');
  });

  it('무시: 비행금지구역을 침범한다', () => {
    const s = launch({ TFR: 'IGNORE' });
    inject(s, tfr(s));
    untilIdleOrFailed(s);
    expect(safety(s).tfrIncursions).toBeGreaterThanOrEqual(1);
  });

  it('복귀: 스테이션에 내리지 않고 도크로 돌아온다', () => {
    const s = launch({ TFR: 'RTH' });
    inject(s, tfr(s));
    untilIdleOrFailed(s);
    expect(s.d.phase).toBe('IDLE');
    expect(s.phases).not.toContain('LANDED');
    expect(safety(s).returns).toBe(1);
  });

  it('통신 두절 중에는 경보를 받지 못해 침범한다', () => {
    const s = launch({ TFR: 'REROUTE', LINK_LOSS: 'CONTINUE' });
    inject(s, { kind: 'LINK_LOSS', droneId: s.d.id, durationSec: 120 });
    s.run(0.1);
    inject(s, tfr(s));
    untilIdleOrFailed(s);
    expect(safety(s).tfrIncursions).toBeGreaterThanOrEqual(1);
  });
});

describe('미등록 장애물 (센서 탐지)', () => {
  const crane = (s: Scenario): HazardSpec => ({ kind: 'OBSTACLE', center: ahead(s.d, 150), sizeM: 16, heightM: 110 });

  it('센서 60m + 재경로: 탐지 후 우회한다', () => {
    const s = launch({ OBSTACLE: 'REROUTE' });
    const id = inject(s, crane(s));
    untilIdleOrFailed(s);
    expect(s.d.phase).toBe('IDLE');
    expect(safety(s).crashes).toBe(0);
    expect(s.e.getSnapshot().hazards.find((h) => h.id === id)?.discovered).toBe(true);
  });

  it('무시: 충돌해 추락한다', () => {
    const s = launch({ OBSTACLE: 'IGNORE' });
    inject(s, crane(s));
    untilIdleOrFailed(s);
    expect(s.d.phase).toBe('FAILED');
    expect(safety(s).crashes).toBe(1);
  });

  it('센서가 너무 짧으면(3m) 재경로 정책이어도 멈추지 못하고 충돌한다', () => {
    const s = launch({ OBSTACLE: 'REROUTE' });
    s.e.dispatch({ type: 'SET_HAZARD_SETTINGS', settings: { sensorRangeM: 3 } });
    inject(s, crane(s));
    untilIdleOrFailed(s);
    expect(safety(s).crashes).toBe(1);
  });
});

describe('비협조 비행체 (정면 접근)', () => {
  const headOn = (s: Scenario, adsb: boolean): HazardSpec => {
    const start = ahead(s.d, 300);
    const headingDeg = ((s.d.headingRad * 180) / Math.PI + 180) % 360;
    return { kind: 'INTRUDER', start, headingDeg, speedMs: 15, altitudeM: s.d.position.z, adsb, durationSec: 120 };
  };

  it('무시: 충돌하거나 근접한다', () => {
    const s = launch({ INTRUDER: 'IGNORE' });
    inject(s, headOn(s, true));
    s.run(40);
    expect(safety(s).crashes + safety(s).nearMisses).toBeGreaterThanOrEqual(1);
  });

  it('ADS-B + 고도 회피: 충돌·근접 없이 지나간다', () => {
    const s = launch({ INTRUDER: 'VERTICAL' });
    inject(s, headOn(s, true));
    untilIdleOrFailed(s);
    expect(safety(s).crashes).toBe(0);
    expect(safety(s).nearMisses).toBe(0);
    expect(s.d.phase).toBe('IDLE');
  });

  it('ADS-B + 제자리 정지: 정면으로 오는 상대는 정지로 피할 수 없다', () => {
    const s = launch({ INTRUDER: 'HOLD' });
    inject(s, headOn(s, true));
    s.run(40);
    expect(safety(s).crashes + safety(s).nearMisses).toBeGreaterThanOrEqual(1);
  });

  it('ADS-B 없이 센서(60m)만으로는 고도 회피가 늦다', () => {
    const s = launch({ INTRUDER: 'VERTICAL' });
    inject(s, headOn(s, false));
    s.run(40);
    expect(safety(s).crashes + safety(s).nearMisses).toBeGreaterThanOrEqual(1);
  });
});

describe('배터리 급감', () => {
  it('무시: 방전으로 추락한다', () => {
    const s = launch({ BATTERY_DROP: 'IGNORE' });
    inject(s, { kind: 'BATTERY_DROP', droneId: s.d.id, toPercent: 3 });
    untilIdleOrFailed(s);
    expect(s.d.phase).toBe('FAILED');
    expect(safety(s).crashes).toBe(1);
  });

  it('가장 가까운 패드 비상착륙: 추락하지 않는다', () => {
    const s = launch({ BATTERY_DROP: 'NEAREST' });
    inject(s, { kind: 'BATTERY_DROP', droneId: s.d.id, toPercent: 3 });
    untilIdleOrFailed(s);
    expect(safety(s).crashes).toBe(0);
    expect(safety(s).emergencyLandings).toBe(1);
  });
});

describe('통신 두절', () => {
  it('대기 후 복귀: 30초 기다렸다가 도크로 돌아온다', () => {
    const s = launch({ LINK_LOSS: 'HOLD_RTH' });
    inject(s, { kind: 'LINK_LOSS', droneId: s.d.id, durationSec: 90 });
    untilIdleOrFailed(s);
    expect(s.d.phase).toBe('IDLE');
    expect(s.phases).toContain('HOLD');
    expect(s.phases).not.toContain('LANDED');
    expect(safety(s).returns).toBe(1);
  });

  it('대기 중 통신이 돌아오면 임무를 이어간다', () => {
    const s = launch({ LINK_LOSS: 'HOLD_RTH' });
    inject(s, { kind: 'LINK_LOSS', droneId: s.d.id, durationSec: 10 });
    untilIdleOrFailed(s);
    expect(s.phases).toContain('HOLD');
    expect(s.phases).toContain('LANDED');
    expect(safety(s).returns).toBe(0);
  });
});

describe('스테이션 폐쇄', () => {
  const southPads = stationPads(defaultMap.stations.find((x) => x.id === 'station-s')!);
  const northPads = stationPads(defaultMap.stations.find((x) => x.id === 'station-n')!);

  it('전환: 다른 스테이션에 착륙한다', () => {
    const s = launch({ STATION_CLOSED: 'DIVERT' });
    inject(s, { kind: 'STATION_CLOSED', stationId: 'station-s', durationSec: 300 });
    untilIdleOrFailed(s);
    expect(s.d.phase).toBe('IDLE');
    expect(northPads).toContainEqual(s.landedAt[0]);
    expect(safety(s).diverts).toBe(1);
  });

  it('상공 대기: 다시 열린 뒤 원래 스테이션에 착륙한다', () => {
    const s = launch({ STATION_CLOSED: 'HOLD' });
    const t0 = s.e.getSnapshot().time;
    inject(s, { kind: 'STATION_CLOSED', stationId: 'station-s', durationSec: 60 });
    let landedT = -1;
    s.run(900, () => {
      if (s.d.phase === 'LANDED' && landedT < 0) landedT = s.e.getSnapshot().time;
      return s.d.phase === 'IDLE';
    });
    expect(southPads).toContainEqual(s.landedAt[0]);
    expect(landedT).toBeGreaterThan(t0 + 60);
    expect(safety(s).closedLandings).toBe(0);
  });

  it('폐쇄 중 새 주문은 전환 정책이면 열린 스테이션으로 배정된다', () => {
    const e = new LocalSimEngine();
    e.load(defaultMap, defaultConfig, 1);
    e.dispatch({ type: 'INJECT_HAZARD', spec: { kind: 'STATION_CLOSED', stationId: 'station-s', durationSec: 600 } });
    e.step(DT);
    e.dispatch({ type: 'CREATE_ORDER', storeId: 'store-cafe', destBuildingId: 'apt-109' });
    for (let i = 0; i < 60; i++) e.step(DT);
    const o = e.getSnapshot().orders[0];
    expect(o.stationId).toBe('station-n');
    expect(o.droneId).not.toBeNull();
  });
});

describe('돌발 상황 예약', () => {
  it('지정한 시각에 발생하고, 지속 시간이 지나면 끝난다', () => {
    const s = launch();
    const now = s.e.getSnapshot().time;
    const id = inject(s, { kind: 'STATION_CLOSED', stationId: 'station-n', durationSec: 20 }, now + 30);
    const status = () => s.e.getSnapshot().hazards.find((h) => h.id === id)!.status;
    expect(status()).toBe('SCHEDULED');
    s.run(29);
    expect(status()).toBe('SCHEDULED');
    s.run(2);
    expect(status()).toBe('ACTIVE');
    s.run(21);
    expect(status()).toBe('ENDED');
  });

  it('예약을 취소할 수 있다', () => {
    const s = launch();
    const id = inject(s, { kind: 'TFR', center: ahead(s.d, 100), radiusM: 40, durationSec: 60 }, s.e.getSnapshot().time + 10);
    s.e.dispatch({ type: 'CANCEL_HAZARD', hazardId: id });
    s.run(15);
    expect(s.e.getSnapshot().hazards.find((h) => h.id === id)!.status).toBe('CANCELLED');
    expect(safety(s).reroutes).toBe(0);
  });
});
