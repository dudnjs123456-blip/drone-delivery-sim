'use client';

import { useState } from 'react';
import { defaultConfig } from '@/sim/config';
import { WEATHER_PRESETS, type WeatherState } from '@/sim/wind/weather';
import { msToKmh } from '@/sim/util/units';
import { useSimStore } from '@/store/simStore';
import { useViewStore } from '@/store/viewStore';
import { isAirborne } from '../phase';
import { formatClock } from './SimControls';

const DIRS = ['북', '북북동', '북동', '동북동', '동', '동남동', '남동', '남남동', '남', '남남서', '남서', '서남서', '서', '서북서', '북서', '북북서'];
export const dirName = (fromDeg: number) => DIRS[Math.round((((fromDeg % 360) + 360) % 360) / 22.5) % 16];

const level = {
  OK: { label: '정상 운항', cls: 'bg-emerald-600' },
  CAUTION: { label: '주의 — 기준에 가까움', cls: 'bg-amber-500' },
  SUSPENDED: { label: '운항 중단', cls: 'bg-red-600 animate-pulse' },
};

/** 바람 나침반: 화살표는 바람이 "불어가는" 방향 */
function Compass({ fromDeg, speed }: { fromDeg: number; speed: number }) {
  const to = ((fromDeg + 180) * Math.PI) / 180;
  const len = Math.min(34, 10 + speed * 2.2);
  const x2 = 50 + Math.sin(to) * len;
  const y2 = 50 - Math.cos(to) * len;
  const x1 = 50 - Math.sin(to) * len * 0.6;
  const y1 = 50 + Math.cos(to) * len * 0.6;
  return (
    <svg viewBox="0 0 100 100" className="h-24 w-24 shrink-0">
      <circle cx="50" cy="50" r="46" fill="#f8fafc" stroke="#cbd5e1" strokeWidth="2" />
      {['N', 'E', 'S', 'W'].map((c, i) => (
        <text key={c} x={50 + Math.sin((i * Math.PI) / 2) * 38} y={53 + -Math.cos((i * Math.PI) / 2) * 38} fontSize="10" textAnchor="middle" fill={c === 'N' ? '#dc2626' : '#64748b'} fontWeight={700}>
          {c}
        </text>
      ))}
      {speed > 0.05 && (
        <>
          <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#0284c7" strokeWidth="5" strokeLinecap="round" />
          <polygon
            points={`${x2},${y2} ${x2 - Math.sin(to - 0.5) * 10},${y2 + Math.cos(to - 0.5) * 10} ${x2 - Math.sin(to + 0.5) * 10},${y2 + Math.cos(to + 0.5) * 10}`}
            fill="#0284c7"
          />
        </>
      )}
      <circle cx="50" cy="50" r="3" fill="#0f172a" />
    </svg>
  );
}

function Bar({ label, value, max, unit }: { label: string; value: number; max: number; unit: string }) {
  const f = Math.min(1, value / max);
  const c = f >= 1 ? 'bg-red-500' : f >= defaultConfig.wind.cautionRatio ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div className="text-[10px] text-slate-600">
      <div className="flex justify-between">
        <span>{label}</span>
        <span className="font-mono">
          {value.toFixed(1)} / {max} {unit}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded bg-slate-200">
        <div className={`h-full ${c}`} style={{ width: `${f * 100}%` }} />
      </div>
    </div>
  );
}

function Now() {
  const w = useSimStore((s) => s.weather);
  const st = w.state;
  const lv = level[w.status.level];
  return (
    <section className="space-y-2">
      <div className={`rounded-md px-2 py-1 text-center text-xs font-bold text-white ${lv.cls}`}>
        {lv.label}
        {w.status.reason && w.status.level === 'SUSPENDED' && <span className="ml-1 font-normal">({w.status.reason})</span>}
      </div>
      <div className="flex items-center gap-3">
        <Compass fromDeg={st.windFromDeg} speed={w.mean10} />
        <div className="grid flex-1 grid-cols-2 gap-x-2 gap-y-1 text-[11px] text-slate-600">
          <div className="col-span-2 text-sm font-bold text-slate-900">
            {w.mean10 < 0.3 ? '무풍' : `${dirName(st.windFromDeg)}풍 ${w.mean10.toFixed(1)} m/s`}
          </div>
          <span>순항 고도({defaultConfig.altitude.cruiseM}m)</span>
          <b className="text-right font-mono text-slate-800">{w.meanCruise.toFixed(1)} m/s</b>
          <span>지금 돌풍</span>
          <b className={`text-right font-mono ${w.gust10 >= defaultConfig.wind.suspendGustMs ? 'text-red-600' : 'text-slate-800'}`}>{w.gust10.toFixed(1)} m/s</b>
          <span>강수 · 기온</span>
          <b className="text-right font-mono text-slate-800">
            {st.rainMmH.toFixed(0)}mm/h · {st.tempC.toFixed(0)}°C
          </b>
          <span>시정</span>
          <b className="text-right font-mono text-slate-800">{st.visibilityM >= 9999 ? '10km+' : `${(st.visibilityM / 1000).toFixed(1)}km`}</b>
        </div>
      </div>
      <Bar label="평균 풍속 (지상 10m) — 운항 중단 기준" value={w.mean10} max={defaultConfig.wind.suspendMeanMs} unit="m/s" />
      <Bar label="돌풍 — 운항 중단 기준" value={w.gust10} max={defaultConfig.wind.suspendGustMs} unit="m/s" />
    </section>
  );
}

function Controls() {
  const w = useSimStore((s) => s.weather);
  const setWeather = useSimStore((s) => s.setWeather);
  const setAuto = useSimStore((s) => s.setWeatherAuto);
  const t = w.target;
  const slider = (label: string, key: keyof WeatherState, min: number, max: number, step: number, fmt: (v: number) => string) => (
    <label className="grid grid-cols-[5.5rem_1fr_3.5rem] items-center gap-1.5 text-[11px] text-slate-600">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={t[key]} onChange={(e) => setWeather({ [key]: Number(e.target.value) }, 3)} />
      <span className="text-right font-mono text-slate-800">{fmt(t[key])}</span>
    </label>
  );
  return (
    <section className="space-y-2 border-t border-slate-200 pt-2">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-bold text-slate-800">날씨 바꾸기</h2>
        <label className="flex cursor-pointer items-center gap-1 text-[11px] text-slate-600">
          <input type="checkbox" checked={w.auto} onChange={(e) => setAuto(e.target.checked)} />
          자동 변화 (바람이 조금씩 바뀜)
        </label>
      </div>
      <div className="grid grid-cols-4 gap-1">
        {WEATHER_PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => setWeather(p.state, defaultConfig.wind.rampSec)}
            title={p.desc}
            className="rounded border border-slate-200 bg-white px-1 py-1 text-[10px] font-medium text-slate-700 hover:bg-slate-50"
          >
            <div className="text-base leading-none">{p.icon}</div>
            {p.label}
          </button>
        ))}
      </div>
      <details>
        <summary className="cursor-pointer text-[11px] font-semibold text-slate-600">세부 조절</summary>
        <div className="space-y-1 pt-1">
          {slider('풍향(불어옴)', 'windFromDeg', 0, 359, 5, (v) => `${dirName(v)} ${v.toFixed(0)}°`)}
          {slider('평균 풍속', 'windMeanMs', 0, 20, 0.5, (v) => `${v.toFixed(1)}m/s`)}
          {slider('돌풍 세기', 'gustiness', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`)}
          {slider('강수', 'rainMmH', 0, 50, 1, (v) => `${v.toFixed(0)}mm/h`)}
          {slider('기온', 'tempC', -20, 40, 1, (v) => `${v.toFixed(0)}°C`)}
          {slider('시정', 'visibilityM', 100, 10000, 100, (v) => `${(v / 1000).toFixed(1)}km`)}
        </div>
      </details>
      <p className="text-[10px] text-slate-400">바뀐 날씨는 {defaultConfig.wind.rampSec}초에 걸쳐 서서히 적용됩니다. 초기화해도 날씨는 유지됩니다.</p>
    </section>
  );
}

function Impact({ tone, icon, title, value, desc }: { tone: 'good' | 'warn' | 'bad' | 'info'; icon: string; title: string; value: string; desc: string }) {
  const cls = { good: 'border-emerald-200 bg-emerald-50', warn: 'border-amber-200 bg-amber-50', bad: 'border-red-200 bg-red-50', info: 'border-slate-200 bg-slate-50' }[tone];
  return (
    <div className={`rounded border px-2 py-1 ${cls}`}>
      <div className="flex items-baseline justify-between gap-1">
        <span className="text-[11px] font-semibold text-slate-700">
          {icon} {title}
        </span>
        <span className="font-mono text-sm font-bold text-slate-900">{value}</span>
      </div>
      <div className="text-[10px] leading-snug text-slate-500">{desc}</div>
    </div>
  );
}

function Impacts() {
  const w = useSimStore((s) => s.weather);
  const drones = useSimStore((s) => s.drones);
  const orders = useSimStore((s) => s.orders);
  const sensor = useSimStore((s) => s.hazardSettings.sensorRangeM);
  const flying = drones.filter((d) => isAirborne(d.phase) && d.weather);
  // 수평으로 순항 중인 드론만 (이착륙·대기 중에는 지면 속도가 원래 0 에 가깝다)
  const cruising = flying.filter((d) => (d.phase === 'CRUISE' || d.phase === 'RETURN') && Math.abs(d.velocity.z) < 0.5 && d.weather!.airSpeedMs > 3);
  const loss = cruising.length ? cruising.reduce((a, d) => a + Math.max(0, 1 - d.weather!.groundSpeedMs / d.weather!.airSpeedMs), 0) / cruising.length : 0;
  const xt = flying.length ? Math.max(...flying.map((d) => d.weather!.crossTrackM)) : 0;
  const extra = w.stats.energyCalm > 0 ? w.stats.energyUsed / w.stats.energyCalm - 1 : w.drainAtCruise - 1;
  const delivered = orders.byStatus.DELIVERED ?? 0;
  const rider = w.stats.riderOrders;
  const pct = (v: number) => `${v >= 0 ? '+' : ''}${Math.round(v * 100)}%`;
  const tone = (v: number, a: number, b: number) => (v >= b ? 'bad' : v >= a ? 'warn' : 'good');

  return (
    <section className="space-y-1 border-t border-slate-200 pt-2">
      <h2 className="text-xs font-bold text-slate-800">영향 한눈에</h2>
      <Impact
        tone={tone(w.drainAtCruise - 1, 0.15, 0.4)}
        icon="🔋"
        title="배터리 소모"
        value={`×${w.drainAtCruise.toFixed(2)}`}
        desc={`지금 날씨로 순항하면 평소보다 ${pct(w.drainAtCruise - 1)} 더 씁니다 (바람·비·추위 합계). 누적 실제 ${pct(extra)}`}
      />
      {w.capacityFactor < 0.999 && (
        <Impact
          tone={tone(1 - w.capacityFactor, 0.1, 0.25)}
          icon="🥶"
          title="배터리 용량"
          value={pct(w.capacityFactor - 1)}
          desc={`기온 ${w.state.tempC.toFixed(0)}°C — 쓸 수 있는 용량이 줄어 비행 가능 시간이 ${Math.round((defaultConfig.drone.enduranceSec * w.capacityFactor) / 60)}분으로`}
        />
      )}
      <Impact
        tone={tone(loss, 0.1, 0.3)}
        icon="🐢"
        title="맞바람 감속"
        value={cruising.length ? `-${Math.round(loss * 100)}%` : '-'}
        desc={`비행 중 드론의 평균 지면 속도 감소. 맞바람으로 늦어진 시간 누적 ${formatClock(w.stats.windDelaySec)}`}
      />
      <Impact
        tone={tone(xt, 3, 8)}
        icon="↔️"
        title="경로 이탈 (돌풍)"
        value={flying.length ? `${xt.toFixed(1)}m` : '-'}
        desc={`지금 가장 많이 밀린 드론. 지금까지 최대 ${w.stats.maxCrossTrackM.toFixed(1)}m`}
      />
      <Impact
        tone={tone(1 - w.sensorFactor, 0.2, 0.5)}
        icon="📡"
        title="센서 탐지 거리"
        value={`${Math.round(sensor * w.sensorFactor)}m`}
        desc={`기본 ${sensor}m → 비·안개로 ${pct(w.sensorFactor - 1)}. 미등록 장애물·비협조 비행체를 늦게 봅니다`}
      />
      <Impact
        tone={w.stats.suspensions ? 'bad' : 'good'}
        icon="🛑"
        title="운항 중단"
        value={`${w.stats.suspensions}회 · ${formatClock(w.stats.suspendedSec)}`}
        desc={`평균 ${defaultConfig.wind.suspendMeanMs}m/s 또는 돌풍 ${defaultConfig.wind.suspendGustMs}m/s 이상이면 새 출발을 멈춥니다`}
      />
      <Impact
        tone={rider ? 'warn' : 'good'}
        icon="🛵"
        title="라이더 전환"
        value={`${rider}건`}
        desc={delivered ? `완료 ${delivered}건 중 드론 ${Math.round(((delivered - Math.min(rider, delivered)) / delivered) * 100)}% · 라이더 ${Math.round((Math.min(rider, delivered) / delivered) * 100)}%` : '운항 중단 중 포장된 주문은 라이더가 가져갑니다'}
      />
    </section>
  );
}

function PerDrone() {
  const drones = useSimStore((s) => s.drones);
  const setSelected = useViewStore((s) => s.setSelected);
  const flying = drones.filter((d) => isAirborne(d.phase) && d.weather);
  if (!flying.length) return <p className="border-t border-slate-200 pt-2 text-[11px] text-slate-400">비행 중인 드론이 없습니다 (주문이나 시험 비행을 넣어 보세요)</p>;
  return (
    <section className="border-t border-slate-200 pt-2">
      <h2 className="mb-1 text-xs font-bold text-slate-800">드론별 바람</h2>
      <table className="w-full text-[10px]">
        <thead className="text-slate-400">
          <tr>
            <th className="text-left font-normal">드론</th>
            <th className="font-normal">바람</th>
            <th className="font-normal">맞/옆</th>
            <th className="font-normal">지면 속도</th>
            <th className="font-normal">소모</th>
            <th className="font-normal">이탈</th>
          </tr>
        </thead>
        <tbody>
          {flying.map((d) => {
            const e = d.weather!;
            return (
              <tr key={d.id} className="cursor-pointer text-slate-700 hover:bg-slate-50" onClick={() => setSelected(d.id)}>
                <td className="font-mono font-semibold">
                  {d.id}
                  {e.inWake && <span title="빌딩풍 구역">🌀</span>}
                </td>
                <td className="text-center font-mono">{e.windMs.toFixed(1)}</td>
                <td className={`text-center font-mono ${e.headwindMs > 3 ? 'text-red-600' : e.headwindMs < -3 ? 'text-emerald-700' : ''}`}>
                  {e.headwindMs >= 0 ? '↓' : '↑'}
                  {Math.abs(e.headwindMs).toFixed(1)} / {e.crosswindMs.toFixed(1)}
                </td>
                <td className="text-center font-mono">
                  {msToKmh(e.groundSpeedMs).toFixed(0)}
                  <span className="text-slate-400">/{msToKmh(e.airSpeedMs).toFixed(0)}</span>
                </td>
                <td className={`text-center font-mono ${e.drainMult > 1.3 ? 'text-red-600' : ''}`}>×{e.drainMult.toFixed(2)}</td>
                <td className="text-center font-mono">{e.crossTrackM.toFixed(1)}m</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-0.5 text-[10px] text-slate-400">맞/옆: ↓맞바람 ↑뒷바람 / 옆바람 (m/s) · 지면 속도: 지면/대기 (km/h) · 🌀 빌딩풍 구역</p>
    </section>
  );
}

function Forecast() {
  const w = useSimStore((s) => s.weather);
  const time = useSimStore((s) => s.time);
  const schedule = useSimStore((s) => s.scheduleWeather);
  const cancel = useSimStore((s) => s.cancelWeather);
  const [preset, setPreset] = useState(WEATHER_PRESETS[3].id);
  const [inSec, setInSec] = useState(60);
  return (
    <section className="space-y-1 border-t border-slate-200 pt-2">
      <h2 className="text-xs font-bold text-slate-800">예보 (정한 시각에 날씨가 바뀜)</h2>
      <div className="flex items-center gap-1 text-[11px]">
        <input type="number" min={5} max={3600} value={inSec} onChange={(e) => setInSec(Math.max(5, Number(e.target.value) || 5))} className="w-14 rounded border border-slate-200 px-1 py-0.5 text-right font-mono" />
        <span className="text-slate-500">초 뒤</span>
        <select value={preset} onChange={(e) => setPreset(e.target.value)} className="flex-1 rounded border border-slate-200 bg-white px-1 py-0.5">
          {WEATHER_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.icon} {p.label}
            </option>
          ))}
        </select>
        <button
          onClick={() => {
            const p = WEATHER_PRESETS.find((x) => x.id === preset)!;
            schedule(inSec, p.state, `${p.icon} ${p.label}`);
          }}
          className="rounded bg-sky-600 px-2 py-0.5 font-medium text-white"
        >
          등록
        </button>
      </div>
      {w.forecasts.map((f) => (
        <div key={f.id} className="flex items-center gap-1 text-[11px] text-slate-700">
          <span className="font-mono text-amber-700">T-{Math.max(0, f.at - time).toFixed(0)}s</span>
          {f.label}
          <button onClick={() => cancel(f.id)} className="ml-auto text-slate-400 hover:text-red-600">
            ✕
          </button>
        </div>
      ))}
    </section>
  );
}

export function WeatherPanel() {
  return (
    <div className="space-y-2">
      <Now />
      <Impacts />
      <Controls />
      <PerDrone />
      <Forecast />
    </div>
  );
}
