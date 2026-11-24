'use client';

import { useSimStore } from '@/store/simStore';
import { type ViewMode, useViewStore } from '@/store/viewStore';
import { isAirborne } from '../phase';

const modes: { mode: Exclude<ViewMode, 'FPV'>; label: string }[] = [
  { mode: '3D', label: '3D 시점' },
  { mode: 'TOP', label: '상단 시점' },
];

export function ViewControls() {
  const viewMode = useViewStore((s) => s.viewMode);
  const setViewMode = useViewStore((s) => s.setViewMode);
  const showLabels = useViewStore((s) => s.showLabels);
  const toggleLabels = useViewStore((s) => s.toggleLabels);
  const showRawPath = useViewStore((s) => s.showRawPath);
  const toggleRawPath = useViewStore((s) => s.toggleRawPath);
  const enterFpv = useViewStore((s) => s.enterFpv);
  const exitFpv = useViewStore((s) => s.exitFpv);
  const selectedId = useViewStore((s) => s.selectedDroneId);
  // 선택한 드론, 없으면 비행 중인 첫 드론, 그것도 없으면 첫 드론
  const fpvTarget = () => {
    const ds = useSimStore.getState().drones;
    return ds.find((d) => d.id === selectedId) ?? ds.find((d) => isAirborne(d.phase)) ?? ds[0];
  };

  return (
    <div className="flex gap-1 rounded-lg bg-white/90 p-1 text-sm shadow-lg backdrop-blur">
      {modes.map(({ mode, label }) => (
        <button
          key={mode}
          onClick={() => setViewMode(mode)}
          className={`rounded-md px-3 py-1.5 font-medium transition ${
            viewMode === mode ? 'bg-slate-800 text-white' : 'text-slate-700 hover:bg-slate-100'
          }`}
        >
          {label}
        </button>
      ))}
      <button
        onClick={() => {
          if (viewMode === 'FPV') exitFpv();
          else {
            const t = fpvTarget();
            if (t) enterFpv(t.id);
          }
        }}
        className={`rounded-md px-3 py-1.5 font-medium transition ${
          viewMode === 'FPV' ? 'bg-slate-800 text-white' : 'text-slate-700 hover:bg-slate-100'
        }`}
        title="선택한 드론(없으면 비행 중인 드론)의 1인칭 시점"
      >
        🎥 1인칭
      </button>
      <div className="mx-1 w-px bg-slate-200" />
      <button
        onClick={toggleLabels}
        className={`rounded-md px-3 py-1.5 font-medium transition ${
          showLabels ? 'bg-slate-100 text-slate-800' : 'text-slate-500 hover:bg-slate-100'
        }`}
      >
        라벨 {showLabels ? '켬' : '끔'}
      </button>
      <button
        onClick={toggleRawPath}
        title="평활화 전 A* 격자 경로"
        className={`rounded-md px-3 py-1.5 font-medium transition ${
          showRawPath ? 'bg-slate-100 text-slate-800' : 'text-slate-500 hover:bg-slate-100'
        }`}
      >
        A* 격자 {showRawPath ? '켬' : '끔'}
      </button>
    </div>
  );
}
