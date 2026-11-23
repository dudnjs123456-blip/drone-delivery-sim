'use client';

import dynamic from 'next/dynamic';
import { defaultMap } from '@/sim/map/defaultMap';
import { defaultMapLabels } from './labels/labels';
import { LabelLayer } from './labels/LabelLayer';
import { useViewStore } from '@/store/viewStore';
import { MapLegend } from './ui/MapLegend';
import { Minimap } from './ui/Minimap';
import { ViewControls } from './ui/ViewControls';

// WebGL 은 브라우저에서만 동작하므로 3D 캔버스는 SSR 에서 제외한다
const SimCanvas = dynamic(() => import('./scene/SimCanvas'), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-slate-500">3D 장면 불러오는 중…</div>,
});

export default function SimApp() {
  const showLabels = useViewStore((s) => s.showLabels);
  return (
    <main className="relative h-screen w-screen overflow-hidden bg-[#cfe3f2]">
      <div className="absolute inset-0">
        <SimCanvas />
      </div>
      <LabelLayer labels={defaultMapLabels} visible={showLabels} />
      <div className="pointer-events-none absolute inset-0 p-4">
        <div className="pointer-events-auto absolute left-4 top-4">
          <MapLegend map={defaultMap} />
        </div>
        <div className="pointer-events-auto absolute right-4 top-4">
          <ViewControls />
        </div>
        <div className="pointer-events-auto absolute bottom-4 left-4">
          <Minimap map={defaultMap} />
        </div>
      </div>
    </main>
  );
}
