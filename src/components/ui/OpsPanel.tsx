'use client';

import { useState } from 'react';
import { defaultConfig } from '@/sim/config';
import { defaultMap } from '@/sim/map/defaultMap';
import type { OrderStatus } from '@/sim/types';
import { type DroneView, useSimStore } from '@/store/simStore';
import { useViewStore } from '@/store/viewStore';
import { phaseColor, phaseLabel } from '../phase';
import { DroneCard } from './DronePanel';

const orderStatusLabel: Record<OrderStatus, string> = {
  COOKING: '조리',
  TO_DOCK: '도크 이동',
  WAITING_DRONE: '드론 대기',
  IN_FLIGHT: '비행',
  AT_STATION: '스테이션',
  LAST_MILE: '문 앞 이동',
  DELIVERED: '완료',
  RIDER_ASSIGNED: '라이더',
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
        <Kpi label="평균 주문→착륙" value={fmtSec(orders.avgTotalSec)} />
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
      <p className="mt-1 text-[10px] text-slate-400">조리·도크 이동·문 앞 인계 시간은 M6 에서 모델링 (지금은 0)</p>
    </Section>
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
  if (d.swapUntil !== null) return '배터리 교체';
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
  return (
    <div className="max-h-[calc(100vh-7rem)] w-[22rem] space-y-2 overflow-y-auto rounded-lg bg-white/95 p-3 shadow-lg backdrop-blur">
      <OrdersSection />
      <TrafficSection />
      <DroneList />
    </div>
  );
}
