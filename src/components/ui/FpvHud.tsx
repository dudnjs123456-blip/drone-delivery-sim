'use client';

import { useEffect } from 'react';
import { defaultConfig } from '@/sim/config';
import { obstacleDistance } from '@/sim/hazards/geometry';
import { msToKmh } from '@/sim/util/units';
import { useSimStore } from '@/store/simStore';
import { useViewStore } from '@/store/viewStore';
import { isAirborne, phaseColor, phaseLabel } from '../phase';

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** 방위 띠: 현재 방위 ±60° 를 눈금으로 */
function Compass({ headingDeg }: { headingDeg: number }) {
  const ticks: { off: number; label: string; major: boolean }[] = [];
  for (let a = -60; a <= 60; a += 5) {
    const deg = (((Math.round(headingDeg / 5) * 5 + a) % 360) + 360) % 360;
    const off = deg - headingDeg;
    const wrapped = ((off + 540) % 360) - 180;
    const major = deg % 45 === 0;
    ticks.push({ off: wrapped, label: major ? CARDINALS[deg / 45] : deg % 15 === 0 ? String(deg) : '', major });
  }
  return (
    <div className="relative h-9 w-[28rem] overflow-hidden rounded bg-black/35 text-white">
      {ticks.map((t, i) => (
        <div key={i} className="absolute top-0 flex flex-col items-center" style={{ left: `calc(50% + ${t.off * 3.6}px)`, transform: 'translateX(-50%)' }}>
          <div className={`w-px bg-white ${t.major ? 'h-3' : 'h-1.5'}`} />
          <div className={`text-[10px] ${t.major ? 'font-bold text-amber-300' : 'text-white/80'}`}>{t.label}</div>
        </div>
      ))}
      <div className="absolute left-1/2 top-0 h-full w-0.5 -translate-x-1/2 bg-amber-400" />
      <div className="absolute bottom-0 left-1/2 -translate-x-1/2 rounded-t bg-amber-400 px-1 font-mono text-[10px] font-bold text-black">
        {Math.round(headingDeg).toString().padStart(3, '0')}°
      </div>
    </div>
  );
}

export function FpvHud() {
  const fpvId = useViewStore((s) => s.fpvDroneId);
  const enterFpv = useViewStore((s) => s.enterFpv);
  const exitFpv = useViewStore((s) => s.exitFpv);
  const drones = useSimStore((s) => s.drones);
  const hazards = useSimStore((s) => s.hazards);
  const sensor = useSimStore((s) => s.hazardSettings.sensorRangeM);
  const d = drones.find((x) => x.id === fpvId);

  // 키보드: Esc 나가기, [ ] 드론 전환 (비행 중인 드론 우선)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'SELECT') return;
      if (e.key === 'Escape') exitFpv();
      if (e.key === '[' || e.key === ']') {
        const list = useSimStore.getState().drones;
        const pool = list.filter((x) => isAirborne(x.phase));
        const cycle = pool.length ? pool : list;
        const cur = useViewStore.getState().fpvDroneId;
        const i = cycle.findIndex((x) => x.id === cur);
        const next = cycle[(i + (e.key === ']' ? 1 : -1) + cycle.length) % cycle.length];
        if (next) enterFpv(next.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enterFpv, exitFpv]);

  if (!d) return null;
  const hs = msToKmh(Math.hypot(d.velocity.x, d.velocity.y));
  const headingDeg = (((d.headingRad * 180) / Math.PI) % 360 + 360) % 360;
  const next = d.path[Math.min(d.pathIndex, d.path.length - 1)];
  const nextDist = next ? Math.hypot(next.x - d.position.x, next.y - d.position.y, next.z - d.position.z) : null;

  // 주변 위협
  const warnings: { text: string; level: 'bad' | 'warn' }[] = [];
  let nearest = Infinity;
  let nearestId = '';
  for (const o of drones) {
    if (o.id === d.id || !isAirborne(o.phase)) continue;
    const dist = Math.hypot(o.position.x - d.position.x, o.position.y - d.position.y, o.position.z - d.position.z);
    if (dist < nearest) {
      nearest = dist;
      nearestId = o.id;
    }
  }
  if (nearest < defaultConfig.traffic.minSeparationM * 2) {
    warnings.push({ text: `드론 ${nearestId} ${nearest.toFixed(0)}m`, level: nearest < defaultConfig.traffic.minSeparationM ? 'bad' : 'warn' });
  }
  for (const h of hazards) {
    if (h.status !== 'ACTIVE') continue;
    const s = h.spec;
    if (s.kind === 'INTRUDER' && h.position) {
      const dist = Math.hypot(h.position.x - d.position.x, h.position.y - d.position.y, h.position.z - d.position.z);
      if (dist < 400) warnings.push({ text: `🚁 비협조 비행체 ${dist.toFixed(0)}m${s.adsb ? '' : ' (ADS-B 없음)'}`, level: dist < 100 ? 'bad' : 'warn' });
    } else if (s.kind === 'TFR') {
      const dist = Math.hypot(s.center.x - d.position.x, s.center.y - d.position.y) - s.radiusM;
      if (dist < 150) warnings.push({ text: dist < 0 ? '⛔ 비행금지구역 안!' : `⛔ 비행금지구역 ${dist.toFixed(0)}m`, level: dist < 30 ? 'bad' : 'warn' });
    } else if (s.kind === 'OBSTACLE') {
      const dist = obstacleDistance(d.position, s, 10);
      if (dist < Math.max(sensor, 40)) {
        warnings.push({ text: `🏗️ 장애물 ${dist.toFixed(0)}m${h.discovered ? '' : ' (미탐지 — 센서 밖)'}`, level: dist < 30 ? 'bad' : 'warn' });
      }
    }
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-20 select-none text-white" style={{ textShadow: '0 1px 2px rgba(0,0,0,0.8)' }}>
      {/* 상단: 방위 */}
      <div className="absolute left-1/2 top-4 -translate-x-1/2">
        <Compass headingDeg={headingDeg} />
      </div>

      {/* 좌상단: 기체 정보 */}
      <div className="pointer-events-auto absolute left-4 top-4 space-y-1 rounded-lg bg-black/45 p-2.5 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-base font-bold">🎥 {d.id}</span>
          <span className="rounded px-1.5 py-0.5 text-[11px] font-semibold" style={{ background: phaseColor[d.phase] }}>
            {phaseLabel[d.phase]}
          </span>
        </div>
        {d.orderId && <div className="text-white/80">주문 {d.orderId}</div>}
        {d.cruiseAltM !== null && <div className="text-white/80">편도 순항 {d.cruiseAltM}m</div>}
        <div className="flex gap-1 pt-1">
          <button
            onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: '[' }))}
            className="rounded bg-white/15 px-2 py-0.5 hover:bg-white/30"
          >
            ◀
          </button>
          <button
            onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: ']' }))}
            className="rounded bg-white/15 px-2 py-0.5 hover:bg-white/30"
          >
            ▶
          </button>
          <button onClick={exitFpv} className="rounded bg-rose-600/80 px-2 py-0.5 hover:bg-rose-600">
            나가기 (Esc)
          </button>
        </div>
        <div className="text-[10px] text-white/60">[ ] 드론 전환 · 드래그 둘러보기 · 더블클릭 정면</div>
      </div>

      {/* 가운데: 조준선 */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <div className="relative h-16 w-16">
          <div className="absolute left-0 top-1/2 h-0.5 w-5 -translate-y-1/2 bg-emerald-300/90" />
          <div className="absolute right-0 top-1/2 h-0.5 w-5 -translate-y-1/2 bg-emerald-300/90" />
          <div className="absolute left-1/2 top-0 h-5 w-0.5 -translate-x-1/2 bg-emerald-300/90" />
          <div className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-300" />
        </div>
      </div>

      {/* 좌: 고도 / 우: 속도 */}
      <div className="absolute left-[18%] top-1/2 -translate-y-1/2 rounded border border-emerald-300/70 bg-black/35 px-3 py-2 text-center">
        <div className="text-[10px] text-emerald-200">ALT</div>
        <div className="font-mono text-2xl font-bold tabular-nums">{d.position.z.toFixed(0)}</div>
        <div className="text-[10px] text-white/70">m · {d.velocity.z >= 0 ? '▲' : '▼'} {Math.abs(d.velocity.z).toFixed(1)} m/s</div>
      </div>
      <div className="absolute right-[30%] top-1/2 -translate-y-1/2 rounded border border-emerald-300/70 bg-black/35 px-3 py-2 text-center">
        <div className="text-[10px] text-emerald-200">SPD</div>
        <div className="font-mono text-2xl font-bold tabular-nums">{hs.toFixed(0)}</div>
        <div className="text-[10px] text-white/70">km/h</div>
      </div>

      {/* 하단 가운데: 경고·상태 */}
      <div className="absolute bottom-24 left-1/2 flex w-[30rem] -translate-x-1/2 flex-col items-center gap-1">
        {d.alert && <div className="rounded bg-amber-500/90 px-3 py-1 text-sm font-bold text-black">⚠ {d.alert}</div>}
        {d.weather && d.weather.windMs > 0.3 && (
          <div className="rounded bg-sky-900/60 px-2 py-0.5 text-xs">
            🌬 {d.weather.windMs.toFixed(1)}m/s · {d.weather.headwindMs >= 0 ? '맞바람' : '뒷바람'} {Math.abs(d.weather.headwindMs).toFixed(1)} · 옆바람{' '}
            {d.weather.crosswindMs.toFixed(1)} · 소모 ×{d.weather.drainMult.toFixed(2)}
            {d.weather.inWake ? ' · 🌀빌딩풍' : ''}
          </div>
        )}
        {warnings.map((w, i) => (
          <div key={i} className={`rounded px-2 py-0.5 text-xs font-semibold ${w.level === 'bad' ? 'animate-pulse bg-red-600/90' : 'bg-black/55'}`}>
            {w.text}
          </div>
        ))}
        <div className="flex w-full items-center gap-3 rounded bg-black/45 px-3 py-1.5 text-xs">
          <span>🔋</span>
          <div className="h-2 flex-1 overflow-hidden rounded bg-white/20">
            <div className={`h-full ${d.battery > 0.3 ? 'bg-emerald-400' : 'bg-red-500'}`} style={{ width: `${(d.battery * 100).toFixed(1)}%` }} />
          </div>
          <span className="w-12 text-right font-mono tabular-nums">{(d.battery * 100).toFixed(1)}%</span>
          <span className="text-white/70">다음 지점</span>
          <span className="w-14 text-right font-mono tabular-nums">{nextDist === null ? '-' : `${nextDist.toFixed(0)}m`}</span>
          {d.linkLostUntil !== null && <span className="rounded bg-red-600 px-1 font-bold">LINK ✕</span>}
        </div>
      </div>
    </div>
  );
}
