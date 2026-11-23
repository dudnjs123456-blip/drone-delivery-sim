'use client';

import { type ViewMode, useViewStore } from '@/store/viewStore';

const modes: { mode: ViewMode; label: string }[] = [
  { mode: '3D', label: '3D 시점' },
  { mode: 'TOP', label: '상단 시점' },
];

export function ViewControls() {
  const viewMode = useViewStore((s) => s.viewMode);
  const setViewMode = useViewStore((s) => s.setViewMode);
  const showLabels = useViewStore((s) => s.showLabels);
  const toggleLabels = useViewStore((s) => s.toggleLabels);

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
      <div className="mx-1 w-px bg-slate-200" />
      <button
        onClick={toggleLabels}
        className={`rounded-md px-3 py-1.5 font-medium transition ${
          showLabels ? 'bg-slate-100 text-slate-800' : 'text-slate-500 hover:bg-slate-100'
        }`}
      >
        라벨 {showLabels ? '켬' : '끔'}
      </button>
    </div>
  );
}
