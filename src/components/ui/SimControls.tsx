'use client';

import { useState } from 'react';
import { defaultConfig } from '@/sim/config';
import { defaultMap } from '@/sim/map/defaultMap';
import { useSimStore } from '@/store/simStore';

export function formatClock(sec: number): string {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const mm = String(m).padStart(2, '0');
  const sss = String(ss).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${sss}` : `${mm}:${sss}`;
}

const btn = 'rounded-md px-2.5 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40';

/** 하단 컨트롤 바: 재생/일시정지, 배속, 초기화, 시험 비행 */
export function SimControls() {
  const { paused, speed, time, drones, message, togglePause, setSpeed, reset, flyMission } = useSimStore();
  const [dockId, setDockId] = useState(defaultMap.docks[0].id);
  const [stationId, setStationId] = useState(defaultMap.stations[0].id);
  const idle = drones.some((d) => d.phase === 'IDLE');

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-white/95 p-2 shadow-lg backdrop-blur">
      <button onClick={togglePause} className={`${btn} w-20 bg-slate-800 text-white hover:bg-slate-700`}>
        {paused ? '▶ 재생' : '⏸ 정지'}
      </button>
      <div className="flex rounded-md bg-slate-100 p-0.5">
        {defaultConfig.time.speedOptions.map((s) => (
          <button
            key={s}
            onClick={() => setSpeed(s)}
            className={`${btn} px-2 ${speed === s ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
          >
            {s}x
          </button>
        ))}
      </div>
      <div className="min-w-16 text-center font-mono text-sm tabular-nums text-slate-700" title="시뮬레이션 경과 시간">
        {formatClock(time)}
      </div>
      <button onClick={reset} className={`${btn} text-slate-600 hover:bg-slate-100`} title="처음 상태로">
        ↺ 초기화
      </button>

      <div className="mx-1 h-6 w-px bg-slate-200" />

      <label className="flex items-center gap-1 text-xs text-slate-500">
        출발
        <select
          value={dockId}
          onChange={(e) => setDockId(e.target.value)}
          className="rounded border border-slate-200 bg-white px-1.5 py-1 text-sm text-slate-800"
        >
          {defaultMap.docks.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name ?? d.id}
            </option>
          ))}
        </select>
      </label>
      <span className="text-slate-400">→</span>
      <label className="flex items-center gap-1 text-xs text-slate-500">
        도착
        <select
          value={stationId}
          onChange={(e) => setStationId(e.target.value)}
          className="rounded border border-slate-200 bg-white px-1.5 py-1 text-sm text-slate-800"
        >
          {defaultMap.stations.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name ?? s.id}
            </option>
          ))}
        </select>
      </label>
      <button
        onClick={() => flyMission(dockId, stationId)}
        disabled={!idle}
        className={`${btn} bg-sky-600 text-white hover:bg-sky-500`}
        title={idle ? '대기 중인 드론으로 시험 비행' : '대기 중인 드론이 없습니다'}
      >
        🛫 시험 비행
      </button>
      {message && !message.ok && <span className="text-xs text-red-600">{message.text}</span>}
    </div>
  );
}
