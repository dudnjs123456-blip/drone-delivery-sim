'use client';

import { engine, useSimStore } from '@/store/simStore';
import { useViewStore } from '@/store/viewStore';
import { formatClock } from './SimControls';

const tone = {
  bad: 'border-red-400 bg-red-600/95 text-white',
  warn: 'border-amber-400 bg-amber-100/95 text-amber-950',
  good: 'border-emerald-400 bg-emerald-50/95 text-emerald-900',
  info: 'border-slate-300 bg-white/95 text-slate-800',
};
const icon = { bad: '🚨', warn: '⚠️', good: '✅', info: 'ℹ️' };

/** 화면 위쪽 사건 알림. 드론이 관련된 알림을 누르면 그 드론으로 카메라가 간다 */
export function EventToasts() {
  const toasts = useSimStore((s) => s.toasts);
  const dismiss = useSimStore((s) => s.dismissToast);
  const track = useViewStore((s) => s.track);
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none absolute left-1/2 top-16 z-30 flex w-[30rem] -translate-x-1/2 flex-col gap-1.5">
      {toasts.map((t) => (
        <button
          key={t.key}
          onClick={() => {
            const d = t.droneId ? engine.getSnapshot().drones.find((x) => x.id === t.droneId) : undefined;
            if (d) track({ kind: 'drone', id: d.id }, d.position.x, d.position.y, 140);
            dismiss(t.key);
          }}
          className={`pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2 text-left text-sm shadow-lg backdrop-blur transition hover:scale-[1.01] ${tone[t.severity]}`}
          style={{ animation: 'toast-in 0.25s ease-out' }}
        >
          <span>{icon[t.severity]}</span>
          <span className="flex-1 leading-snug">{t.text}</span>
          <span className="shrink-0 font-mono text-[11px] opacity-70">{formatClock(t.t)}</span>
          {t.droneId && <span className="shrink-0 text-[11px] underline opacity-80">보기</span>}
        </button>
      ))}
    </div>
  );
}
