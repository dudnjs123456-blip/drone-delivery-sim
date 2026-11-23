import { palette } from '@/components/scene/palette';
import { defaultConfig } from '@/sim/config';
import type { MapData } from '@/sim/types';

export function MapLegend({ map }: { map: MapData }) {
  const apts = map.buildings.filter((b) => b.kind === 'APARTMENT');
  const coms = map.buildings.filter((b) => b.kind === 'COMMERCIAL');
  const tallest = Math.max(...apts.map((b) => b.heightM));

  const items = [
    { color: '#8b95a1', label: `아파트 ${apts.length}개 동 (최고 ${tallest}m)` },
    { color: palette.commercialWall, label: `상가 ${coms.length}개` },
    { color: palette.store, label: `가게 ${map.stores.length}곳` },
    { color: palette.dock, label: `옥상 이륙 도크 ${map.docks.length}곳` },
    { color: palette.station, label: `착륙 스테이션 ${map.stations.length}곳` },
    { color: palette.noFly, label: `비행금지구역 ${map.noFlyZones.length}곳` },
  ];

  return (
    <div className="w-64 rounded-lg bg-white/90 p-3 text-sm shadow-lg backdrop-blur">
      <h1 className="text-base font-bold text-slate-900">드론 배송 시뮬레이터</h1>
      <p className="mb-2 text-xs text-slate-500">{map.name} · M1 장면</p>
      <ul className="space-y-1">
        {items.map((it) => (
          <li key={it.label} className="flex items-center gap-2 text-slate-700">
            <span className="inline-block h-3 w-3 rounded-sm" style={{ background: it.color }} />
            {it.label}
          </li>
        ))}
      </ul>
      <p className="mt-2 border-t border-slate-200 pt-2 text-[11px] leading-relaxed text-slate-500">
        순항 고도 {defaultConfig.altitude.cruiseM}m · 고도 제한 {defaultConfig.altitude.maxM}m
        <br />
        드래그: 회전 · 우클릭 드래그: 이동 · 휠: 확대
      </p>
    </div>
  );
}
