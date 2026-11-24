import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../config';
import { limitsFromConfig } from '../flight/kinematics';
import { isAirborneStage, newProgress, stepMission } from '../flight/mission';
import { buildTripLegs } from '../flight/route';
import { predictMission } from './predict';
import { ReservationTable } from './reservationTable';
import { findSeparationViolations } from './separation';
import type { Drone } from '../types';

const bounds = { minX: -300, minY: -300, maxX: 300, maxY: 300, maxZ: 170 };

describe('ReservationTable', () => {
  it('같은 시간 칸의 이웃 셀은 충돌, 두 칸 떨어지면 통과', () => {
    const t = new ReservationTable(bounds, 15);
    t.reserve('A', 10, [[t.cellKey(0, 0, 60)]]);
    expect(t.isFree('B', 10, [[t.cellKey(14, 0, 60)]])).toBe(false); // 이웃 셀
    expect(t.isFree('B', 10, [[t.cellKey(0, 0, 74)]])).toBe(false); // 위층 이웃
    expect(t.isFree('B', 10, [[t.cellKey(31, 0, 60)]])).toBe(true); // 두 칸 너머
    expect(t.isFree('B', 11, [[t.cellKey(0, 0, 60)]])).toBe(true); // 다른 시간 칸
    expect(t.isFree('A', 10, [[t.cellKey(0, 0, 60)]])).toBe(true); // 자기 예약은 무시
  });

  it('셀이 이웃하지 않으면 실제 거리는 셀 크기 이상', () => {
    const t = new ReservationTable(bounds, 15);
    // 무작위 점 쌍으로 확인
    let seed = 1;
    const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 200 - 100;
    for (let n = 0; n < 2000; n++) {
      const a = { x: r(), y: r(), z: 60 + r() / 4 };
      const b = { x: a.x + r() / 3, y: a.y + r() / 3, z: a.z + r() / 6 };
      const tt = new ReservationTable(bounds, 15);
      tt.reserve('A', 0, [[tt.cellKey(a.x, a.y, a.z)]]);
      if (tt.isFree('B', 0, [[tt.cellKey(b.x, b.y, b.z)]])) {
        expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeGreaterThanOrEqual(15);
      }
    }
    expect(t.size).toBe(0);
  });

  it('prune 은 지난 칸을 지운다', () => {
    const t = new ReservationTable(bounds, 15);
    t.reserve('A', 5, [[1], [2], [3]]);
    expect(t.size).toBe(3);
    t.prune(7);
    expect(t.size).toBe(1);
  });
});

describe('predictMission', () => {
  it('예측은 실제 stepMission 실행과 정확히 같은 시점에 착륙·복귀한다', () => {
    const lim = limitsFromConfig(defaultConfig);
    const dt = defaultConfig.time.fixedDtSec;
    const home = { x: -230, y: -150, z: 12 };
    const pad = { x: 170, y: -60, z: 0 };
    const legs = { out: buildTripLegs(home, pad, 60), back: buildTripLegs(pad, home, 60), dwellSteps: 600 };
    const table = new ReservationTable(bounds, 15);
    const pred = predictMission(legs, home, lim, dt, 20, table);

    // 출발 스텝을 1000 으로 두고 엔진처럼 실행
    const departStep = 1000;
    const m = { ...legs, departStep };
    const pr = newProgress();
    const kin = { position: { ...home }, velocity: { x: 0, y: 0, z: 0 } };
    const at: Record<string, number> = {};
    let airborne = 0;
    for (let step = 1; step < 20000; step++) {
      const ev = stepMission(m, pr, kin, step, lim, dt);
      if (ev) at[ev] ??= step;
      if (isAirborneStage(pr.stage)) airborne++;
      if (ev === 'ARRIVED_HOME') break;
    }
    expect(at.DEPART).toBe(departStep);
    expect(at.LANDED - departStep).toBe(pred.landedStep);
    expect(at.RETURN_START - departStep).toBe(pred.returnStartStep);
    expect(at.ARRIVED_HOME - departStep).toBe(pred.doneStep);
    expect(airborne).toBe(pred.airborneSteps);
    // 하역 중(지상)에는 예약이 없다
    const dwellSlots = pred.footprint.slice(Math.ceil(pred.landedStep / 20) + 1, Math.floor(pred.returnStartStep / 20));
    expect(dwellSlots.every((s) => s.length === 0)).toBe(true);
  });
});

describe('findSeparationViolations', () => {
  it('최소 이격 거리보다 가까운 쌍만 찾는다', () => {
    const d = (id: string, x: number) => ({ id, position: { x, y: 0, z: 60 } }) as Drone;
    const v = findSeparationViolations([d('A', 0), d('B', 10), d('C', 40)], 15);
    expect(v).toEqual([{ a: 'A', b: 'B', distM: 10 }]);
  });
});
