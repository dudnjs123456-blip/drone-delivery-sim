'use client';

import { useSimStore } from '@/store/simStore';
import { dirName } from './WeatherPanel';

/** 한 줄 날씨 요약 (항상 보이는 곳에) */
export function WeatherLine({ dark = false }: { dark?: boolean }) {
  const w = useSimStore((s) => s.weather);
  const lv = w.status.level;
  const dot = lv === 'SUSPENDED' ? 'bg-red-500 animate-pulse' : lv === 'CAUTION' ? 'bg-amber-400' : 'bg-emerald-500';
  const st = w.state;
  return (
    <div className={`flex flex-wrap items-center gap-x-1.5 text-[11px] ${dark ? 'text-white/90' : 'text-slate-700'}`}>
      <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
      <b>{lv === 'SUSPENDED' ? '운항 중단' : lv === 'CAUTION' ? '운항 주의' : '운항 정상'}</b>
      <span>
        🌬 {w.mean10 < 0.3 ? '무풍' : `${dirName(st.windFromDeg)}풍 ${w.mean10.toFixed(1)}m/s`}
        {w.mean10 >= 0.3 && <span className="opacity-70"> (60m {w.meanCruise.toFixed(1)}) · 돌풍 {w.gust10.toFixed(1)}</span>}
      </span>
      {st.rainMmH > 0 && <span>🌧 {st.rainMmH.toFixed(0)}mm/h</span>}
      {st.tempC < 5 && <span>🥶 {st.tempC.toFixed(0)}°C</span>}
      {st.visibilityM < 2000 && <span>🌫 {(st.visibilityM / 1000).toFixed(1)}km</span>}
      {w.drainAtCruise > 1.05 && <span className="font-semibold text-amber-600">🔋×{w.drainAtCruise.toFixed(2)}</span>}
    </div>
  );
}
