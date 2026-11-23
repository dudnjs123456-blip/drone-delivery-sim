'use client';

import * as THREE from 'three';
import { memo, useCallback } from 'react';
import { type LabelSpec, labelAnchors, labelElements } from './labels';

const LabelItem = memo(function LabelItem({ spec }: { spec: LabelSpec }) {
  const { id, anchor, dynamic } = spec;
  // id 가 같으면 ref 를 다시 붙이지 않는다 (텍스트만 바뀔 때 위치가 튀지 않도록)
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) return;
      labelElements.set(id, el);
      if (!dynamic || !labelAnchors.has(id)) labelAnchors.set(id, new THREE.Vector3(...anchor));
      return () => {
        labelElements.delete(id);
        labelAnchors.delete(id);
      };
    },
    // anchor 는 정적 라벨에서만 의미가 있고 지도는 바뀌지 않으므로 id 만 의존한다
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id],
  );

  return (
    <div ref={ref} style={{ position: 'absolute', left: 0, top: 0, visibility: 'hidden', willChange: 'transform' }}>
      <div
        className={`whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-semibold shadow-sm ${
          spec.color ? 'text-white' : 'bg-white/85 text-slate-800'
        } ${spec.highlight ? 'ring-2 ring-white' : ''}`}
        style={spec.color ? { background: spec.color } : undefined}
      >
        {spec.text}
        {spec.sub && <span className={`ml-1 font-normal ${spec.color ? 'text-white/85' : 'text-slate-500'}`}>{spec.sub}</span>}
      </div>
    </div>
  );
});

/** 캔버스 위에 겹쳐 그리는 라벨 DOM. 위치는 LabelProjector 가 갱신한다 */
export function LabelLayer({ labels, visible }: { labels: LabelSpec[]; visible: boolean }) {
  return (
    // z-0 으로 별도 쌓임 맥락을 만들어, 라벨끼리의 zIndex 가 UI 패널 위로 올라가지 않게 한다
    <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden" style={{ display: visible ? undefined : 'none' }}>
      {labels.map((l) => (
        <LabelItem key={l.id} spec={l} />
      ))}
    </div>
  );
}
