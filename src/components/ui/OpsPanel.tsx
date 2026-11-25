'use client';

import { useState } from 'react';
import { defaultConfig } from '@/sim/config';
import { defaultMap } from '@/sim/map/defaultMap';
import { polygonCentroid } from '@/sim/util/geometry';
import type { OrderStatus } from '@/sim/types';
import { ORDER_SEGMENTS, type DroneView, engine, useSimStore } from '@/store/simStore';
import { useViewStore } from '@/store/viewStore';
import { phaseColor, phaseLabel } from '../phase';
import { runnerDisplayPos } from '../scenePos';
import { DroneCard } from './DronePanel';
import { HazardPanel } from './HazardPanel';
import { WeatherPanel } from './WeatherPanel';

const orderStatusLabel: Record<OrderStatus, string> = {
  KITCHEN_QUEUE: '주방 대기',
  COOKING: '조리',
  PACKING: '포장',
  READY: '운반 대기',
  LOADING: '적재',
  TO_DOCK: '도크로 운반',
  WAITING_DRONE: '드론 대기',
  IN_FLIGHT: '비행',
  AT_STATION: '스테이션',
  LAST_MILE: '문 앞 이동',
  DELIVERED: '완료',
  RIDER_ASSIGNED: '라이더',
  FAILED: '실패',
};

const storeName = (id: string) => defaultMap.stores.find((s) => s.id === id)?.name ?? id;
const buildingName = (id: string) => defaultMap.buildings.find((b) => b.id === id)?.name ?? id;
const fmtSec = (v: number | null) => (v === null ? '-' : v >= 60 ? `${Math.floor(v / 60)}분 ${Math.round(v % 60)}초` : `${v.toFixed(0)}초`);

function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-t border-slate-200 pt-2 first:border-t-0 first:pt-0">
      <div className="mb-1.5 flex items-center justify-between">
        <h2 className="text-xs font-bold text-slate-800">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: 'bad' | 'good' }) {
  return (
    <div className="rounded bg-slate-50 px-2 py-1">
      <div className="text-[10px] text-slate-500">{label}</div>
      <div
        className={`font-mono text-sm tabular-nums ${tone === 'bad' ? 'text-red-600' : tone === 'good' ? 'text-emerald-700' : 'text-slate-900'}`}
      >
        {value}
      </div>
    </div>
  );
}

function OrdersSection() {
  const orders = useSimStore((s) => s.orders);
  const peak = useSimStore((s) => s.peakOrdersPerMin);
  const createOrder = useSimStore((s) => s.createOrder);
  const setPeak = useSimStore((s) => s.setPeak);
  const [rate, setRate] = useState(defaultConfig.orders.defaultPeakPerMin);
  const by = orders.byStatus;

  return (
    <Section title="주문">
      <div className="mb-2 flex items-center gap-1.5">
        <button onClick={createOrder} className="rounded-md bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-500">
          + 주문 1건
        </button>
        <div className="ml-auto flex items-center gap-1 text-xs text-slate-600">
          피크
          <input
            type="number"
            min={1}
            max={30}
            value={rate}
            onChange={(e) => setRate(Math.max(1, Math.min(30, Number(e.target.value) || 1)))}
            className="w-12 rounded border border-slate-200 px-1 py-0.5 text-right font-mono"
          />
          건/분
          <button
            onClick={() => setPeak(peak === null ? rate : null)}
            className={`rounded-md px-2 py-1 font-medium ${peak !== null ? 'bg-rose-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}
          >
            {peak !== null ? `■ 중지 (${peak}건/분)` : '▶ 시작'}
          </button>
        </div>
      </div>
      <div className="grid grid-cols-4 gap-1">
        <Kpi label="드론 대기" value={String(by.WAITING_DRONE ?? 0)} tone={(by.WAITING_DRONE ?? 0) > 10 ? 'bad' : undefined} />
        <Kpi label="비행 중" value={String(by.IN_FLIGHT ?? 0)} />
        <Kpi label="완료" value={String(by.DELIVERED ?? 0)} />
        <Kpi label="전체" value={String(orders.total)} />
      </div>
      <div className="mt-1 grid grid-cols-2 gap-1">
        <Kpi label="평균 주문→이륙" value={fmtSec(orders.avgWaitSec)} />
        <Kpi label="주방·포장·운반 중" value={String((by.KITCHEN_QUEUE ?? 0) + (by.COOKING ?? 0) + (by.PACKING ?? 0) + (by.READY ?? 0) + (by.TO_DOCK ?? 0))} />
      </div>
      {orders.recent.length > 0 && (
        <table className="mt-1.5 w-full text-[11px]">
          <tbody>
            {orders.recent.map((o) => (
              <tr key={o.id} className="text-slate-600">
                <td className="py-0.5 font-mono">{o.id}</td>
                <td>
                  {storeName(o.storeId)} → {buildingName(o.destBuildingId)}
                </td>
                <td className="font-mono">{o.droneId ?? '-'}</td>
                <td className={`text-right ${o.status === 'DELIVERED' ? 'text-emerald-700' : 'text-slate-800'}`}>
                  {orderStatusLabel[o.status]}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <SegmentBar />
      <p className="mt-1 text-[10px] text-slate-400">스테이션 → 문 앞 인계는 M6 에서 모델링</p>
    </Section>
  );
}

const SCALES = [
  { v: 1, l: '실제' },
  { v: 0.5, l: '½' },
  { v: 0.2, l: '⅕' },
  { v: 0.1, l: '1/10' },
  { v: 0, l: '즉시' },
];

/** 가게별 주방·포장·운반 현황 */
function StoresSection() {
  const kitchens = useSimStore((s) => s.kitchens);
  const runners = useSimStore((s) => s.runners);
  const scale = useSimStore((s) => s.firstMileScale);
  const setScale = useSimStore((s) => s.setFirstMileScale);
  const shelf = useSimStore((s) => s.orders.shelfByDock);
  const requestFocus = useViewStore((s) => s.requestFocus);
  const track = useViewStore((s) => s.track);
  const followRunnerId = useViewStore((s) => s.followRunnerId);
  const followRunner = (storeId: string) => {
    const r = engine.getSnapshot().runners.find((x) => x.storeId === storeId);
    if (!r) return;
    const st = defaultMap.stores.find((x) => x.id === storeId)!;
    // 가게 정면 비스듬히 위에서 (건물 안으로 카메라가 들어가지 않게)
    const b = defaultMap.buildings.find((x) => x.id === st.buildingId)!;
    const [bx, by] = polygonCentroid(b.footprint);
    const p = runnerDisplayPos(r).pos;
    track({ kind: 'runner', id: r.id }, p.x, p.y, 60, { x: st.position.x - bx + 0.4 * (st.position.y - by), y: st.position.y - by });
  };

  return (
    <Section
      title="가게 · 주방"
      right={
        <div className="flex items-center gap-0.5 text-[10px] text-slate-500">
          공정 시간
          {SCALES.map((x) => (
            <button
              key={x.v}
              onClick={() => setScale(x.v)}
              className={`rounded px-1.5 py-0.5 ${scale === x.v ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
            >
              {x.l}
            </button>
          ))}
        </div>
      }
    >
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-[10px] text-slate-400">
            <th className="text-left font-normal">가게</th>
            <th className="font-normal">주방 대기</th>
            <th className="font-normal">조리</th>
            <th className="font-normal">포장</th>
            <th className="font-normal">운반</th>
          </tr>
        </thead>
        <tbody>
          {kitchens.map((k) => {
            const st = defaultMap.stores.find((s) => s.id === k.storeId)!;
            const r = runners.filter((x) => x.storeId === k.storeId);
            const moving = r.find((x) => x.phase === 'TO_DOCK');
            return (
              <tr key={k.storeId} className="text-slate-700">
                <td className="py-0.5">
                  <button onClick={() => {
                      // 가게 정면(건물 중심 → 가게 방향)에서 바라본다
                      const b = defaultMap.buildings.find((x) => x.id === st.buildingId)!;
                      const [bx, by] = polygonCentroid(b.footprint);
                      requestFocus(st.position.x, st.position.y, 90, { x: st.position.x - bx, y: st.position.y - by });
                    }} className="text-left underline decoration-dotted hover:text-sky-700" title="가까이 보기">
                    {st.name}
                  </button>
                </td>
                <td className={`text-center font-mono ${k.queue > 3 ? 'font-semibold text-red-600' : ''}`}>{k.queue}</td>
                <td className="text-center font-mono">
                  {k.cooking.length}/{k.maxCooking}
                </td>
                <td className="text-center font-mono">{k.packing + k.ready}</td>
                <td className="text-center text-[10px]">
                  <button
                    onClick={() => followRunner(k.storeId)}
                    className={`rounded px-1 ${r.some((x) => x.id === followRunnerId) ? 'bg-sky-600 text-white' : 'hover:bg-slate-100'}`}
                    title="직원을 가까이 따라가기 (다음 운반도 계속 따라감)"
                  >
                    {moving ? `🧑 ${moving.carrying}개` : r.some((x) => x.phase === 'BACK') ? '복귀 중' : '대기'} 🎥
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mt-1 flex flex-wrap gap-1.5 text-[10px] text-slate-500">
        {defaultMap.docks.map((d) => (
          <button
            key={d.id}
            onClick={() => requestFocus(d.position.x, d.position.y, 75, { x: 0.3, y: -1 })}
            className="rounded border border-slate-200 px-1.5 py-0.5 hover:bg-slate-100"
            title="옥상 도크 가까이 보기 (선반 → 적재 → 이륙)"
          >
            🎥 {d.name} · 선반 <b className="text-slate-700">{shelf[d.id] ?? 0}</b>
          </button>
        ))}
      </div>
      <p className="mt-1 text-[10px] leading-snug text-slate-400">
        🎥 를 누르면 카메라가 가까이 갑니다. 직원 따라가기는 1x 배속에서 보기 좋습니다.
      </p>
    </Section>
  );
}

/** 완료 주문의 구간별 평균 시간 (주문 → 착륙) */
function SegmentBar() {
  const seg = useSimStore((s) => s.orders.avgSegments);
  const total = ORDER_SEGMENTS.reduce((a, x) => a + (seg[x.key] ?? 0), 0);
  if (!total) return null;
  return (
    <div className="mt-1.5">
      <div className="mb-0.5 text-[10px] text-slate-500">완료 주문 평균 구간 (주문 → 착륙 {fmtSec(total)})</div>
      <div className="flex h-3 overflow-hidden rounded">
        {ORDER_SEGMENTS.map((x) => {
          const v = seg[x.key] ?? 0;
          return v > 0 ? <div key={x.key} style={{ width: `${(v / total) * 100}%`, background: x.color }} title={`${x.label} ${fmtSec(v)}`} /> : null;
        })}
      </div>
      <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-slate-600">
        {ORDER_SEGMENTS.map((x) => (
          <span key={x.key}>
            <span className="mr-0.5 inline-block h-2 w-2 rounded-sm" style={{ background: x.color }} />
            {x.label} {fmtSec(seg[x.key] ?? 0)}
          </span>
        ))}
      </div>
    </div>
  );
}

function TrafficSection() {
  const t = useSimStore((s) => s.traffic);
  const drones = useSimStore((s) => s.drones);
  const setReservations = useSimStore((s) => s.setReservations);
  const flying = drones.filter((d) => d.phase !== 'IDLE' && d.phase !== 'LANDED').length;

  return (
    <Section
      title="교통 관제"
      right={
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-600">
          시간-공간 예약
          <button
            role="switch"
            aria-checked={t.reservationsEnabled}
            onClick={() => setReservations(!t.reservationsEnabled)}
            className={`relative h-5 w-9 rounded-full transition ${t.reservationsEnabled ? 'bg-emerald-500' : 'bg-slate-300'}`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition ${t.reservationsEnabled ? 'left-4' : 'left-0.5'}`}
            />
          </button>
        </label>
      }
    >
      {!t.reservationsEnabled && (
        <div className="mb-1.5 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
          예약 꺼짐: 새 임무가 충돌 확인 없이 바로 출발합니다 (비교용)
        </div>
      )}
      {t.activeViolations > 0 && (
        <div className="mb-1.5 animate-pulse rounded border border-red-300 bg-red-50 px-2 py-1 text-xs font-semibold text-red-700">
          ⚠ 이격 거리 {defaultConfig.traffic.minSeparationM}m 위반 {t.activeViolations}쌍
        </div>
      )}
      <div className="grid grid-cols-3 gap-1">
        <Kpi label="운항 중 드론" value={`${flying}/${drones.length}`} />
        <Kpi label="현재 위반" value={String(t.activeViolations)} tone={t.activeViolations ? 'bad' : 'good'} />
        <Kpi label="누적 위반" value={String(t.violationEvents)} tone={t.violationEvents ? 'bad' : 'good'} />
        <Kpi label="평균 출발 지연" value={`${t.avgTrafficDelaySec.toFixed(1)}s`} />
        <Kpi label="120m 배정" value={`${(t.altitudeShiftRatio * 100).toFixed(0)}%`} />
        <Kpi label="예약 셀" value={t.reservedCells.toLocaleString()} />
      </div>
    </Section>
  );
}

function droneStatus(d: DroneView, time: number): string {
  if (d.alert) return d.alert;
  if (d.swapUntil !== null) return '배터리 교체';
  if (d.departAt !== null && time >= d.departAt - defaultConfig.kitchen.loadSec) return `적재 중 ${Math.max(0, d.departAt - time).toFixed(0)}s`;
  if (d.departAt !== null) return `출발 T-${Math.max(0, d.departAt - time).toFixed(0)}s`;
  return phaseLabel[d.phase];
}

function DroneList() {
  const drones = useSimStore((s) => s.drones);
  const time = useSimStore((s) => s.time);
  const alerts = useSimStore((s) => s.alerts);
  const selectedId = useViewStore((s) => s.selectedDroneId);
  const setSelected = useViewStore((s) => s.setSelected);
  const violating = new Set(alerts.flatMap((a) => (a.type === 'SEPARATION_VIOLATION' ? a.droneIds : [])));
  const selected = drones.find((d) => d.id === selectedId);

  return (
    <Section title={`드론 ${drones.length}대`} right={<span className="text-[10px] text-slate-400">행을 누르면 상세</span>}>
      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
        {drones.map((d) => (
          <button
            key={d.id}
            onClick={() => setSelected(d.id === selectedId ? null : d.id)}
            className={`flex items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-[11px] ${
              d.id === selectedId ? 'bg-amber-100' : 'hover:bg-slate-100'
            } ${violating.has(d.id) ? 'ring-1 ring-red-500' : ''}`}
          >
            <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: phaseColor[d.phase] }} />
            <span className="font-mono font-semibold text-slate-800">{d.id}</span>
            <span className="truncate text-slate-600">{droneStatus(d, time)}</span>
            <span className={`ml-auto font-mono tabular-nums ${d.battery < 0.3 ? 'text-red-600' : 'text-slate-500'}`}>
              {Math.round(d.battery * 100)}%
            </span>
          </button>
        ))}
      </div>
      {selected && (
        <div className="mt-2 rounded border border-amber-200 bg-amber-50/40 p-2">
          <DroneCard d={selected} />
        </div>
      )}
    </Section>
  );
}

export function OpsPanel() {
  const [tab, setTab] = useState<'ops' | 'hazard' | 'weather'>('ops');
  const wlevel = useSimStore((s) => s.weather.status.level);
  const wmean = useSimStore((s) => s.weather.mean10);
  const activeHazards = useSimStore((s) => s.hazards.filter((h) => h.status === 'ACTIVE' || h.status === 'SCHEDULED').length);
  return (
    <div className="flex max-h-[calc(100vh-7rem)] w-[23rem] flex-col rounded-lg bg-white/95 shadow-lg backdrop-blur">
      <div className="flex border-b border-slate-200 text-xs font-semibold">
        <button
          onClick={() => setTab('ops')}
          className={`flex-1 rounded-tl-lg px-3 py-2 ${tab === 'ops' ? 'bg-white text-slate-900' : 'bg-slate-100 text-slate-500 hover:text-slate-800'}`}
        >
          운항 관제
        </button>
        <button
          onClick={() => setTab('hazard')}
          className={`flex-1 px-3 py-2 ${tab === 'hazard' ? 'bg-white text-slate-900' : 'bg-slate-100 text-slate-500 hover:text-slate-800'}`}
        >
          ⚡ 돌발 상황{activeHazards > 0 && <span className="ml-1 rounded-full bg-rose-600 px-1.5 text-[10px] text-white">{activeHazards}</span>}
        </button>
        <button
          onClick={() => setTab('weather')}
          className={`flex-1 rounded-tr-lg px-3 py-2 ${tab === 'weather' ? 'bg-white text-slate-900' : 'bg-slate-100 text-slate-500 hover:text-slate-800'}`}
        >
          🌬 날씨
          <span
            className={`ml-1 rounded-full px-1.5 text-[10px] text-white ${wlevel === 'SUSPENDED' ? 'bg-red-600' : wlevel === 'CAUTION' ? 'bg-amber-500' : 'bg-emerald-600'}`}
          >
            {wmean.toFixed(0)}m/s
          </span>
        </button>
      </div>
      <div className="space-y-2 overflow-y-auto p-3">
        {tab === 'ops' ? (
          <>
            <OrdersSection />
            <StoresSection />
            <TrafficSection />
            <DroneList />
          </>
        ) : tab === 'hazard' ? (
          <HazardPanel />
        ) : (
          <WeatherPanel />
        )}
      </div>
    </div>
  );
}
