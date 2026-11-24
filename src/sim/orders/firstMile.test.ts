import { describe, expect, it } from 'vitest';
import { type SimConfig, defaultConfig } from '../config';
import { LocalSimEngine } from '../engine/LocalSimEngine';
import { defaultMap } from '../map/defaultMap';
import type { OrderStatus } from '../types';
import { dockShelfPoint, kitchenProfile, pointAlongRunnerPath, runnerPath } from './firstMile';

const DT = defaultConfig.time.fixedDtSec;

function engine(scale = 1, cfg: SimConfig = defaultConfig) {
  const e = new LocalSimEngine();
  e.load(defaultMap, cfg, 1);
  e.dispatch({ type: 'SET_FIRST_MILE_SCALE', scale });
  return e;
}
const run = (e: LocalSimEngine, sec: number, each?: () => boolean | void) => {
  for (let i = 0; i < Math.round(sec / DT); i++) {
    e.step(DT);
    if (each?.()) return;
  }
};

describe('운반 경로', () => {
  it('가게 앞 지상에서 시작해 도크 옥상 선반에서 끝난다', () => {
    for (const st of defaultMap.stores) {
      const p = runnerPath(defaultMap, st);
      const dock = defaultMap.docks.find((d) => d.id === st.dockId)!;
      expect(p[0]).toEqual({ x: st.position.x, y: st.position.y, z: 0 });
      expect(p[p.length - 1]).toEqual(dockShelfPoint(defaultMap, dock));
      expect(pointAlongRunnerPath(p, 0)).toEqual(p[0]);
      expect(pointAlongRunnerPath(p, 1)).toEqual(p[p.length - 1]);
      // 중간에 옥상 높이까지 올라간다
      expect(Math.max(...p.map((q) => q.z))).toBe(dock.position.z);
    }
  });
});

describe('주방 → 포장 → 운반 → 적재 → 이륙', () => {
  it('주문은 단계 순서대로 지나가고, 구간 시각이 차례로 기록된다', () => {
    const e = engine(1);
    e.dispatch({ type: 'CREATE_ORDER', storeId: 'store-cafe', destBuildingId: 'apt-109' });
    const o = e.getSnapshot().orders[0];
    const seen: OrderStatus[] = [o.status];
    run(e, 900, () => {
      if (seen[seen.length - 1] !== o.status) seen.push(o.status);
      return o.status === 'DELIVERED';
    });
    // 직원이 비어 있으면 포장이 끝난 스텝에 바로 들고 나가므로 READY 는 건너뛸 수 있다
    expect(seen.filter((x) => x !== 'READY')).toEqual(['KITCHEN_QUEUE', 'COOKING', 'PACKING', 'TO_DOCK', 'WAITING_DRONE', 'LOADING', 'IN_FLIGHT', 'DELIVERED']);
    const t = o.t;
    const order = [t.created, t.cookStart, t.cookDone, t.packStart, t.packDone, t.pickedUp, t.atDock, t.assigned, t.loadStart, t.takeoff, t.landed, t.delivered];
    for (let i = 1; i < order.length; i++) expect(order[i]!).toBeGreaterThanOrEqual(order[i - 1]!);

    const prof = kitchenProfile(defaultConfig, 'store-cafe');
    const cook = t.cookDone! - t.cookStart!;
    expect(cook).toBeGreaterThanOrEqual(prof.cookMinSec - DT);
    expect(cook).toBeLessThanOrEqual(prof.cookMaxSec + DT);
    // 가게 → 도크 도보 시간
    const walk = defaultMap.stores.find((s) => s.id === 'store-cafe')!.walkToDockSec;
    expect(t.atDock! - t.pickedUp!).toBeCloseTo(walk, 0);
    // 적재 시간
    expect(t.takeoff! - t.loadStart!).toBeCloseTo(defaultConfig.kitchen.loadSec, 0);
  });

  it('동시 조리 수를 넘지 않고, 넘치는 주문은 주방 대기열에 쌓인다', () => {
    const e = engine(1);
    const prof = kitchenProfile(defaultConfig, 'store-cafe');
    for (let i = 0; i < prof.maxCooking + 4; i++) e.dispatch({ type: 'CREATE_ORDER', storeId: 'store-cafe' });
    let maxCooking = 0;
    let sawQueue = false;
    run(e, 600, () => {
      const os = e.getSnapshot().orders;
      maxCooking = Math.max(maxCooking, os.filter((o) => o.status === 'COOKING').length);
      if (os.some((o) => o.status === 'KITCHEN_QUEUE')) sawQueue = true;
    });
    expect(maxCooking).toBe(prof.maxCooking);
    expect(sawQueue).toBe(true);
  });

  it('직원은 준비된 주문을 한 번에 여러 개(최대 정원) 나른다', () => {
    const e = engine(0);
    const cap = kitchenProfile(defaultConfig, 'store-pizza').runnerCapacity;
    for (let i = 0; i < cap + 2; i++) e.dispatch({ type: 'CREATE_ORDER', storeId: 'store-pizza' });
    let maxCarry = 0;
    run(e, 30, () => {
      for (const r of e.getSnapshot().runners) maxCarry = Math.max(maxCarry, r.orderIds.length);
    });
    expect(maxCarry).toBeGreaterThan(1);
    expect(maxCarry).toBeLessThanOrEqual(cap);
  });

  it('적재 중 드론은 패드 위에 있고 화물을 싣고 있다', () => {
    const e = engine(0);
    e.dispatch({ type: 'CREATE_ORDER', storeId: 'store-chicken', destBuildingId: 'apt-101' });
    const o = e.getSnapshot().orders[0];
    run(e, 120, () => o.status === 'LOADING');
    expect(o.status).toBe('LOADING');
    const d = e.getSnapshot().drones.find((x) => x.id === o.droneId)!;
    expect(d.phase).toBe('IDLE');
    expect(d.payloadKg).toBe(o.weightKg);
    expect(d.position.z).toBe(defaultMap.docks.find((x) => x.id === 'dock-a')!.position.z);
  });

  it('시간 배율을 줄이면 퍼스트 마일이 그만큼 짧아진다', () => {
    const firstMile = (scale: number) => {
      const e = engine(scale);
      e.dispatch({ type: 'CREATE_ORDER', storeId: 'store-chicken', destBuildingId: 'apt-101' });
      const o = e.getSnapshot().orders[0];
      run(e, 3000, () => o.t.atDock !== undefined);
      return o.t.atDock! - o.t.created;
    };
    const full = firstMile(1);
    const fast = firstMile(0.1);
    expect(full).toBeGreaterThan(600);
    expect(fast).toBeLessThan(full * 0.15);
  });
});
