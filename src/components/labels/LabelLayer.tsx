'use client';

import { type LabelSpec, labelElements } from './labels';

/** 캔버스 위에 겹쳐 그리는 라벨 DOM. 위치는 LabelProjector 가 갱신한다 */
export function LabelLayer({ labels, visible }: { labels: LabelSpec[]; visible: boolean }) {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" style={{ display: visible ? undefined : 'none' }}>
      {labels.map((l) => (
        <div
          key={l.id}
          ref={(el) => {
            if (el) labelElements.set(l.id, el);
            else labelElements.delete(l.id);
          }}
          // 첫 프레임 전에는 숨겨 둔다
          style={{ position: 'absolute', left: 0, top: 0, visibility: 'hidden', willChange: 'transform' }}
        >
          <div
            className={`whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-semibold shadow-sm ${
              l.color ? 'text-white' : 'bg-white/85 text-slate-800'
            }`}
            style={l.color ? { background: l.color } : undefined}
          >
            {l.text}
            {l.sub && <span className={`ml-1 font-normal ${l.color ? 'text-white/80' : 'text-slate-500'}`}>{l.sub}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
