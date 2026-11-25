'use client';

import { useViewStore } from '@/store/viewStore';

/** 카메라 조작 안내 (자유 비행·궤도) */
export function CameraHelp() {
  const mode = useViewStore((s) => s.viewMode);
  const speed = useViewStore((s) => s.flySpeed);
  if (mode === 'FLY') {
    return (
      <div className="pointer-events-none absolute bottom-24 left-1/2 z-20 -translate-x-1/2 rounded-lg bg-slate-900/80 px-4 py-2 text-center text-xs text-white shadow-lg">
        <div className="mb-0.5 font-semibold">🕹 자유 비행 — 속도 {speed.toFixed(0)} m/s</div>
        <div className="text-white/80">
          <b>W A S D</b> 이동 · <b>Q / E</b> 아래 · 위 · <b>Shift</b> 4배 빠르게 · <b>드래그</b> 둘러보기 · <b>휠</b> 속도 조절 · <b>Esc</b> 궤도 시점으로
        </div>
      </div>
    );
  }
  if (mode === '3D' || mode === 'TOP') {
    return (
      <div className="pointer-events-none absolute bottom-24 left-1/2 z-10 -translate-x-1/2 rounded bg-white/70 px-3 py-1 text-[11px] text-slate-600 shadow">
        드래그 회전 · 우클릭 드래그(또는 방향키) 이동 · 휠 커서 쪽으로 확대 · <b>더블클릭</b> 그 지점을 중심으로 · <b>🕹 자유 비행</b>으로 어디든
      </div>
    );
  }
  return null;
}
