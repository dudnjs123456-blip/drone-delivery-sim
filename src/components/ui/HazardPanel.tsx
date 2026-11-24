'use client';

import { useState } from 'react';
import { defaultMap } from '@/sim/map/defaultMap';
import type { HazardKind, HazardSpec, HazardState, ResponsePolicies } from '@/sim/hazards/types';
import type { Vec3 } from '@/sim/types';
import { type DroneView, useSimStore } from '@/store/simStore';
import { useViewStore } from '@/store/viewStore';
import { HAZARD_CATALOG, HAZARD_KINDS } from '../hazardCatalog';
import { isAirborne } from '../phase';
import { formatClock } from './SimControls';

const field = 'w-full rounded border border-slate-200 bg-white px-1.5 py-0.5 text-xs text-slate-800';

function Num({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
}) {
  return (
    <label className="flex items-center gap-1.5 text-[11px] text-slate-600">
      <span className="w-20 shrink-0">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Math.min(max, Math.max(min, Number(e.target.value) || 0)))}
        className={`${field} w-20 text-right font-mono`}
      />
      {unit && <span className="text-slate-400">{unit}</span>}
    </label>
  );
}

/** 드론 남은 경로를 따라 dist(수평) 앞의 점. 경로가 없으면 진행 방향으로 */
function pointAhead(d: DroneView, dist: number): { x: number; y: number } {
  const pts: Vec3[] = [d.position, ...d.path.slice(Math.max(1, d.pathIndex))];
  let left = dist;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (seg >= left && seg > 0) {
      const t = left / seg;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    left -= seg;
  }
  return { x: d.position.x + Math.sin(d.headingRad) * dist, y: d.position.y + Math.cos(d.headingRad) * dist };
}

type LocMode = 'ahead' | 'picked' | 'center';

function InjectSection() {
  const drones = useSimStore((s) => s.drones);
  const time = useSimStore((s) => s.time);
  const injectHazard = useSimStore((s) => s.injectHazard);
  const selectedId = useViewStore((s) => s.selectedDroneId);
  const pickMode = useViewStore((s) => s.pickMode);
  const picked = useViewStore((s) => s.pickedPoint);
  const setPickMode = useViewStore((s) => s.setPickMode);

  const [kind, setKind] = useState<HazardKind>('TFR');
  const [loc, setLoc] = useState<LocMode>('ahead');
  const [aheadM, setAheadM] = useState(150);
  const [radius, setRadius] = useState(50);
  const [tfrDur, setTfrDur] = useState(180);
  const [obsH, setObsH] = useState(110);
  const [obsSize, setObsSize] = useState(16);
  const [intrSpeed, setIntrSpeed] = useState(15);
  const [intrAdsb, setIntrAdsb] = useState(true);
  const [intrHeading, setIntrHeading] = useState(90);
  const [intrAlt, setIntrAlt] = useState(60);
  const [intrDur, setIntrDur] = useState(120);
  const [battery, setBattery] = useState(5);
  const [targetMode, setTargetMode] = useState<'selected' | 'random'>('selected');
  const [linkDur, setLinkDur] = useState(60);
  const [stationId, setStationId] = useState(defaultMap.stations[0].id);
  const [closeDur, setCloseDur] = useState(120);
  const [timing, setTiming] = useState<'now' | 'delay'>('now');
  const [delay, setDelay] = useState(30);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const flying = drones.filter((d) => isAirborne(d.phase));
  // 위치 기준 드론: 선택한 드론이 비행 중이면 그 드론, 아니면 비행 중인 첫 드론
  const refDrone = flying.find((d) => d.id === selectedId) ?? flying[0];
  const targetDrone = drones.find((d) => d.id === selectedId);
  const needsLoc = kind === 'TFR' || kind === 'OBSTACLE' || kind === 'INTRUDER';

  const center = (): { x: number; y: number } | null => {
    if (loc === 'picked') return picked;
    if (loc === 'center') {
      const b = defaultMap.bounds;
      return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
    }
    return refDrone ? pointAhead(refDrone, kind === 'INTRUDER' ? Math.max(aheadM, 200) : aheadM) : null;
  };

  const build = (): HazardSpec | string => {
    const c = needsLoc ? center() : null;
    if (needsLoc && !c) return loc === 'ahead' ? '비행 중인 드론이 없습니다 (위치 기준)' : '미니맵에서 위치를 고르세요';
    switch (kind) {
      case 'TFR':
        return { kind, center: c!, radiusM: radius, durationSec: tfrDur > 0 ? tfrDur : null };
      case 'OBSTACLE':
        return { kind, center: c!, sizeM: obsSize, heightM: obsH };
      case 'INTRUDER': {
        // 드론 전방 기준이면: 그 드론을 향해 정면으로 날아오게
        if (loc === 'ahead' && refDrone) {
          const hd = (Math.atan2(refDrone.position.x - c!.x, refDrone.position.y - c!.y) * 180) / Math.PI;
          return { kind, start: c!, headingDeg: (hd + 360) % 360, speedMs: intrSpeed, altitudeM: Math.round(refDrone.position.z), adsb: intrAdsb, durationSec: intrDur };
        }
        return { kind, start: c!, headingDeg: intrHeading, speedMs: intrSpeed, altitudeM: intrAlt, adsb: intrAdsb, durationSec: intrDur };
      }
      case 'BATTERY_DROP':
        if (targetMode === 'selected' && !targetDrone) return '드론 목록에서 대상을 먼저 선택하세요';
        return { kind, droneId: targetMode === 'selected' ? targetDrone!.id : null, toPercent: battery };
      case 'LINK_LOSS':
        if (targetMode === 'selected' && !targetDrone) return '드론 목록에서 대상을 먼저 선택하세요';
        return { kind, droneId: targetMode === 'selected' ? targetDrone!.id : null, durationSec: linkDur };
      case 'STATION_CLOSED':
        return { kind, stationId, durationSec: closeDur };
    }
  };

  const submit = () => {
    const spec = build();
    if (typeof spec === 'string') {
      setMsg({ ok: false, text: spec });
      return;
    }
    setMsg(injectHazard(spec, timing === 'delay' ? time + delay : undefined));
  };

  const info = HAZARD_CATALOG[kind];

  return (
    <section className="space-y-2">
      <div className="grid grid-cols-3 gap-1">
        {HAZARD_KINDS.map((k) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            className={`rounded px-1 py-1 text-[11px] font-medium ${kind === k ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}
          >
            {HAZARD_CATALOG[k].icon} {HAZARD_CATALOG[k].title}
          </button>
        ))}
      </div>
      <div className="rounded bg-slate-50 px-2 py-1.5 text-[11px] leading-relaxed text-slate-600">
        <div>{info.what}</div>
        <div className="text-slate-500">
          <b className="font-semibold text-slate-700">인지:</b> {info.detection}
        </div>
      </div>

      {needsLoc && (
        <div className="space-y-1">
          <div className="flex gap-1 text-[11px]">
            {(
              [
                ['ahead', '드론 전방'],
                ['picked', '미니맵 지정'],
                ['center', '단지 중앙'],
              ] as const
            ).map(([v, l]) => (
              <button
                key={v}
                onClick={() => setLoc(v)}
                className={`rounded px-2 py-0.5 ${loc === v ? 'bg-sky-600 text-white' : 'bg-slate-100 text-slate-700'}`}
              >
                {l}
              </button>
            ))}
          </div>
          {loc === 'ahead' && (
            <div className="flex items-center gap-2">
              <Num label="전방 거리" value={aheadM} onChange={setAheadM} min={30} max={600} step={10} unit="m" />
              <span className="text-[10px] text-slate-500">{refDrone ? `기준 ${refDrone.id}` : '비행 중인 드론 없음'}</span>
            </div>
          )}
          {loc === 'picked' && (
            <div className="flex items-center gap-2 text-[11px]">
              <button
                onClick={() => setPickMode(pickMode ? null : 'hazard')}
                className={`rounded px-2 py-0.5 ${pickMode ? 'animate-pulse bg-amber-500 text-white' : 'bg-slate-100 text-slate-700'}`}
              >
                {pickMode ? '미니맵을 클릭하세요…' : '📍 위치 고르기'}
              </button>
              <span className="font-mono text-slate-500">{picked ? `(${picked.x.toFixed(0)}, ${picked.y.toFixed(0)})` : '미지정'}</span>
            </div>
          )}
        </div>
      )}

      <div className="space-y-1">
        {kind === 'TFR' && (
          <>
            <Num label="반경" value={radius} onChange={setRadius} min={10} max={200} step={5} unit="m" />
            <Num label="지속 (0=무기한)" value={tfrDur} onChange={setTfrDur} min={0} max={3600} step={10} unit="s" />
          </>
        )}
        {kind === 'OBSTACLE' && (
          <>
            <Num label="높이" value={obsH} onChange={setObsH} min={20} max={150} step={5} unit="m" />
            <Num label="폭" value={obsSize} onChange={setObsSize} min={4} max={60} step={2} unit="m" />
          </>
        )}
        {kind === 'INTRUDER' && (
          <>
            <Num label="속도" value={intrSpeed} onChange={setIntrSpeed} min={3} max={60} unit="m/s" />
            {loc !== 'ahead' && (
              <>
                <Num label="방위 (북=0)" value={intrHeading} onChange={setIntrHeading} min={0} max={359} step={5} unit="°" />
                <Num label="고도" value={intrAlt} onChange={setIntrAlt} min={20} max={150} step={5} unit="m" />
              </>
            )}
            {loc === 'ahead' && <p className="text-[10px] text-slate-500">기준 드론을 향해 같은 고도로 정면 접근합니다</p>}
            <Num label="지속" value={intrDur} onChange={setIntrDur} min={10} max={600} step={10} unit="s" />
            <label className="flex items-center gap-1.5 text-[11px] text-slate-600">
              <input type="checkbox" checked={intrAdsb} onChange={(e) => setIntrAdsb(e.target.checked)} />
              ADS-B 송신 (UTM 경보로 일찍 알 수 있음)
            </label>
          </>
        )}
        {(kind === 'BATTERY_DROP' || kind === 'LINK_LOSS') && (
          <div className="flex items-center gap-1 text-[11px]">
            <span className="w-20 text-slate-600">대상</span>
            {(
              [
                ['selected', targetDrone ? `선택 드론 (${targetDrone.id})` : '선택 드론'],
                ['random', '비행 중 무작위'],
              ] as const
            ).map(([v, l]) => (
              <button
                key={v}
                onClick={() => setTargetMode(v)}
                className={`rounded px-2 py-0.5 ${targetMode === v ? 'bg-sky-600 text-white' : 'bg-slate-100 text-slate-700'}`}
              >
                {l}
              </button>
            ))}
          </div>
        )}
        {kind === 'BATTERY_DROP' && <Num label="남는 잔량" value={battery} onChange={setBattery} min={0} max={50} unit="%" />}
        {kind === 'LINK_LOSS' && <Num label="두절 시간" value={linkDur} onChange={setLinkDur} min={5} max={600} step={5} unit="s" />}
        {kind === 'STATION_CLOSED' && (
          <>
            <label className="flex items-center gap-1.5 text-[11px] text-slate-600">
              <span className="w-20">스테이션</span>
              <select value={stationId} onChange={(e) => setStationId(e.target.value)} className={field}>
                {defaultMap.stations.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name ?? s.id}
                  </option>
                ))}
              </select>
            </label>
            <Num label="폐쇄 시간" value={closeDur} onChange={setCloseDur} min={10} max={1800} step={10} unit="s" />
          </>
        )}
      </div>

      <div className="flex items-center gap-1.5 border-t border-slate-100 pt-2 text-[11px]">
        <span className="text-slate-600">시점</span>
        <button onClick={() => setTiming('now')} className={`rounded px-2 py-0.5 ${timing === 'now' ? 'bg-sky-600 text-white' : 'bg-slate-100'}`}>
          즉시
        </button>
        <button onClick={() => setTiming('delay')} className={`rounded px-2 py-0.5 ${timing === 'delay' ? 'bg-sky-600 text-white' : 'bg-slate-100'}`}>
          예약
        </button>
        {timing === 'delay' && (
          <>
            <input
              type="number"
              min={1}
              max={3600}
              value={delay}
              onChange={(e) => setDelay(Math.max(1, Number(e.target.value) || 1))}
              className={`${field} w-14 text-right font-mono`}
            />
            <span className="text-slate-500">초 뒤 (T={formatClock(time + delay)})</span>
          </>
        )}
        <button onClick={submit} className="ml-auto rounded-md bg-rose-600 px-3 py-1 text-xs font-semibold text-white hover:bg-rose-500">
          ⚡ 주입
        </button>
      </div>
      {msg && <div className={`text-[11px] ${msg.ok ? 'text-emerald-700' : 'text-red-600'}`}>{msg.text}</div>}
    </section>
  );
}

function PolicySection() {
  const policies = useSimStore((s) => s.policies);
  const settings = useSimStore((s) => s.hazardSettings);
  const setPolicies = useSimStore((s) => s.setPolicies);
  const setHazardSettings = useSimStore((s) => s.setHazardSettings);
  const [open, setOpen] = useState<HazardKind | null>(null);

  return (
    <section className="space-y-1.5 border-t border-slate-200 pt-2">
      <h2 className="text-xs font-bold text-slate-800">대응 정책</h2>
      {HAZARD_KINDS.map((k) => {
        const info = HAZARD_CATALOG[k];
        const current = policies[k];
        const opt = info.options.find((o) => o.value === current);
        return (
          <div key={k} className="rounded border border-slate-100 px-2 py-1">
            <div className="flex items-center gap-1.5">
              <span className="w-28 shrink-0 text-[11px] font-medium text-slate-700">
                {info.icon} {info.title}
              </span>
              <select
                value={current}
                onChange={(e) => setPolicies({ [k]: e.target.value } as Partial<ResponsePolicies>)}
                className={field}
              >
                {info.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <button onClick={() => setOpen(open === k ? null : k)} className="text-[11px] text-slate-400 hover:text-slate-700" title="대응 방법 설명">
                {open === k ? '▲' : 'ⓘ'}
              </button>
            </div>
            <div className="mt-0.5 text-[10px] leading-snug text-slate-500">{opt?.desc}</div>
            {open === k && (
              <div className="mt-1 space-y-0.5 rounded bg-slate-50 p-1.5 text-[10px] leading-snug text-slate-600">
                {info.options.map((o) => (
                  <div key={o.value}>
                    <b className="text-slate-700">{o.label}</b> — {o.desc}
                  </div>
                ))}
                <div className="border-t border-slate-200 pt-0.5">
                  <b className="text-slate-700">실제 운용에서 함께 쓰는 대책</b> — {info.realWorld}
                </div>
              </div>
            )}
          </div>
        );
      })}
      <div className="grid grid-cols-1 gap-1 pt-1">
        <Num
          label="센서 탐지 거리"
          value={settings.sensorRangeM}
          onChange={(v) => setHazardSettings({ sensorRangeM: v })}
          min={2}
          max={300}
          step={5}
          unit="m (정지 거리 ≈31m)"
        />
        <Num
          label="ADS-B 경보 거리"
          value={settings.adsbAlertRangeM}
          onChange={(v) => setHazardSettings({ adsbAlertRangeM: v })}
          min={20}
          max={1000}
          step={10}
          unit="m"
        />
        <Num
          label="두절 시 대기"
          value={settings.linkLossHoldSec}
          onChange={(v) => setHazardSettings({ linkLossHoldSec: v })}
          min={1}
          max={300}
          step={5}
          unit="s"
        />
      </div>
    </section>
  );
}

const statusLabel: Record<HazardState['status'], string> = { SCHEDULED: '예약', ACTIVE: '진행 중', ENDED: '종료', CANCELLED: '취소' };

function HazardList() {
  const hazards = useSimStore((s) => s.hazards);
  const time = useSimStore((s) => s.time);
  const cancel = useSimStore((s) => s.cancelHazard);
  const live = hazards.filter((h) => h.status === 'ACTIVE' || h.status === 'SCHEDULED');
  if (live.length === 0) return null;
  return (
    <section className="space-y-1 border-t border-slate-200 pt-2">
      <h2 className="text-xs font-bold text-slate-800">예약·진행 중</h2>
      {live.map((h) => {
        const info = HAZARD_CATALOG[h.spec.kind];
        const extra =
          h.spec.kind === 'OBSTACLE' ? (h.discovered ? ` · ${h.discoveredBy} 탐지·공유됨` : ' · 미탐지') : h.targetDroneId ? ` · ${h.targetDroneId}` : '';
        return (
          <div key={h.id} className="flex items-center gap-1.5 text-[11px]">
            <span className="font-mono text-slate-400">{h.id}</span>
            <span className="text-slate-700">
              {info.icon} {info.title}
              <span className="text-slate-500">{extra}</span>
            </span>
            <span className={`ml-auto rounded px-1 ${h.status === 'ACTIVE' ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-800'}`}>
              {h.status === 'SCHEDULED' ? `T-${Math.max(0, h.at - time).toFixed(0)}s` : statusLabel[h.status]}
            </span>
            <button onClick={() => cancel(h.id)} className="text-slate-400 hover:text-red-600" title={h.status === 'SCHEDULED' ? '취소' : '종료'}>
              ✕
            </button>
          </div>
        );
      })}
    </section>
  );
}

function SafetySection() {
  const s = useSimStore((st) => st.safety);
  const log = useSimStore((st) => st.hazardLog);
  const items: [string, number, 'bad' | 'warn' | 'good'][] = [
    ['추락', s.crashes, 'bad'],
    ['근접(NMAC)', s.nearMisses, 'bad'],
    ['금지구역 침범', s.tfrIncursions, 'bad'],
    ['폐쇄 착륙', s.closedLandings, 'bad'],
    ['배송 실패', s.ordersFailed, 'bad'],
    ['재경로', s.reroutes, 'good'],
    ['공중 대기', s.holds, 'warn'],
    ['복귀', s.returns, 'warn'],
    ['비상착륙', s.emergencyLandings, 'warn'],
    ['스테이션 전환', s.diverts, 'good'],
    ['주문 재배정', s.ordersRequeued, 'warn'],
  ];
  const tone = { bad: 'text-red-600', warn: 'text-amber-700', good: 'text-emerald-700' };
  const sev = { bad: 'text-red-700', warn: 'text-amber-800', good: 'text-emerald-700', info: 'text-slate-600' };
  return (
    <section className="space-y-1.5 border-t border-slate-200 pt-2">
      <h2 className="text-xs font-bold text-slate-800">안전 지표</h2>
      <div className="grid grid-cols-4 gap-1">
        {items.map(([l, v, t]) => (
          <div key={l} className="rounded bg-slate-50 px-1.5 py-0.5">
            <div className="text-[9px] text-slate-500">{l}</div>
            <div className={`font-mono text-sm tabular-nums ${v ? tone[t] : 'text-slate-400'}`}>{v}</div>
          </div>
        ))}
      </div>
      {log.length > 0 && (
        <div className="max-h-44 space-y-0.5 overflow-y-auto rounded bg-slate-50 p-1.5 font-mono text-[10px] leading-snug">
          {[...log]
            .reverse()
            .slice(0, 40)
            .map((e, i) => (
              <div key={`${e.t}-${i}`} className={sev[e.severity]}>
                <span className="text-slate-400">{formatClock(e.t)}</span> {e.text}
              </div>
            ))}
        </div>
      )}
    </section>
  );
}

export function HazardPanel() {
  return (
    <div className="space-y-2">
      <InjectSection />
      <HazardList />
      <PolicySection />
      <SafetySection />
    </div>
  );
}
