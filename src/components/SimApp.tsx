'use client';

import dynamic from 'next/dynamic';
import { useMemo } from 'react';
import { defaultMap } from '@/sim/map/defaultMap';
import { useSimStore } from '@/store/simStore';
import { useViewStore } from '@/store/viewStore';
import { type LabelSpec, defaultMapLabels } from './labels/labels';
import { LabelLayer } from './labels/LabelLayer';
import { phaseColor, phaseLabel } from './phase';
import { HAZARD_CATALOG } from './hazardCatalog';
import { enuToThree } from './coords';
import { FpvHud } from './ui/FpvHud';
import { MapLegend } from './ui/MapLegend';
import { Minimap } from './ui/Minimap';
import { OpsPanel } from './ui/OpsPanel';
import { SimControls } from './ui/SimControls';
import { ViewControls } from './ui/ViewControls';

// WebGL 은 브라우저에서만 동작하므로 3D 캔버스는 SSR 에서 제외한다
const SimCanvas = dynamic(() => import('./scene/SimCanvas'), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-slate-500">3D 장면 불러오는 중…</div>,
});

export default function SimApp() {
  const showLabels = useViewStore((s) => s.showLabels);
  const followDroneId = useViewStore((s) => s.followDroneId);
  const selectedDroneId = useViewStore((s) => s.selectedDroneId);
  const viewMode = useViewStore((s) => s.viewMode);
  // 진행 중인 돌발 상황 라벨 (상태가 바뀔 때만 다시 만든다)
  const hazardKey = useSimStore((s) =>
    s.hazards
      .filter((h) => h.status === 'ACTIVE')
      .map((h) => `${h.id}|${h.discovered ? 1 : 0}`)
      .join(','),
  );
  const hazards = useSimStore((s) => s.hazards);
  // 라벨 텍스트는 단계·배터리·위반 여부가 바뀔 때만 갱신된다 (위치는 매 프레임 Drones 가 갱신)
  // 격납고에서 쉬는 드론은 라벨을 숨긴다 (도크에 겹쳐 보이지 않도록)
  const droneLabelKey = useSimStore((s) => {
    const bad = new Set(s.alerts.flatMap((a) => (a.type === 'SEPARATION_VIOLATION' ? a.droneIds : [])));
    return s.drones
      .filter((d) => d.phase !== 'IDLE' || d.departAt !== null)
      .map((d) => `${d.id}|${d.departAt !== null ? 'READY' : d.phase}|${Math.round(d.battery * 100)}|${bad.has(d.id) ? 1 : 0}|${d.alert ?? ''}`)
      .join(',');
  });

  const labels = useMemo<LabelSpec[]>(() => {
    const droneLabels: LabelSpec[] = droneLabelKey
      .split(',')
      .filter(Boolean)
      .map((k) => {
        const [id, phase, battery, bad, alert] = k.split('|') as [string, keyof typeof phaseLabel | 'READY', string, string, string];
        const violating = bad === '1';
        return {
          id: `drone:${id}`,
          text: violating ? `⚠ ${id}` : alert ? `⚠ ${id} ${alert}` : `${id} ${phase === 'READY' ? '출발 대기' : phaseLabel[phase]}`,
          sub: `${battery}%`,
          color: violating || phase === 'FAILED' ? '#dc2626' : alert ? '#c2410c' : phase === 'READY' ? '#b45309' : phaseColor[phase],
          anchor: [0, -1000, 0],
          dynamic: true,
          highlight: id === followDroneId || id === selectedDroneId,
        };
      });
    const hazardLabels: LabelSpec[] = [];
    for (const key of hazardKey.split(',').filter(Boolean)) {
      const h = hazards.find((x) => x.id === key.split('|')[0]);
      if (!h) continue;
      const s = h.spec;
      const info = HAZARD_CATALOG[s.kind];
      if (s.kind === 'TFR') {
        hazardLabels.push({ id: `hazard:${h.id}`, text: `${info.icon} ${info.title}`, sub: `r=${s.radiusM}m`, color: '#ea580c', anchor: enuToThree(s.center.x, s.center.y, 155) });
      } else if (s.kind === 'OBSTACLE') {
        hazardLabels.push({
          id: `hazard:${h.id}`,
          text: `${info.icon} ${h.discovered ? '장애물 (공유됨)' : '미탐지 장애물'}`,
          sub: `${s.heightM}m`,
          color: h.discovered ? '#a16207' : '#525252',
          anchor: enuToThree(s.center.x, s.center.y, s.heightM + 8),
        });
      } else if (s.kind === 'INTRUDER') {
        hazardLabels.push({ id: `hazard:${h.id}`, text: `${info.icon} 비협조 비행체`, sub: s.adsb ? 'ADS-B' : 'ADS-B 없음', color: '#e11d48', anchor: [0, -1000, 0], dynamic: true });
      }
    }
    return [...defaultMapLabels, ...droneLabels, ...hazardLabels];
    // hazards 는 hazardKey 가 바뀔 때만 다시 읽으면 된다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [droneLabelKey, followDroneId, selectedDroneId, hazardKey]);

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-[#cfe3f2]">
      <div className="absolute inset-0">
        <SimCanvas />
      </div>
      <LabelLayer labels={labels} visible={showLabels} />
      {viewMode === 'FPV' && <FpvHud />}
      <div className="pointer-events-none absolute inset-0 z-10">
        {viewMode !== 'FPV' && (
          <div className="pointer-events-auto absolute left-4 top-4">
            <MapLegend map={defaultMap} />
          </div>
        )}
        <div className="pointer-events-auto absolute right-4 top-4 flex flex-col items-end gap-2">
          <ViewControls />
          <OpsPanel />
        </div>
        <div className="pointer-events-auto absolute bottom-4 left-4">
          <Minimap map={defaultMap} />
        </div>
        <div className="pointer-events-auto absolute bottom-4 left-1/2 w-max max-w-[calc(100vw-2rem)] -translate-x-1/2">
          <SimControls />
        </div>
      </div>
    </main>
  );
}
