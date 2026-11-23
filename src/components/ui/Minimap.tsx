'use client';

import type { MouseEvent } from 'react';
import { palette } from '@/components/scene/palette';
import type { MapData } from '@/sim/types';
import { useViewStore } from '@/store/viewStore';

/**
 * 상단 2D 미니맵. SVG 좌표는 (x, -y) 로 그려 북쪽이 위로 오게 한다.
 * 클릭하면 카메라가 그 지점으로 이동한다.
 */
export function Minimap({ map }: { map: MapData }) {
  const camera = useViewStore((s) => s.camera);
  const requestFocus = useViewStore((s) => s.requestFocus);
  const { minX, minY, maxX, maxY } = map.bounds;
  const w = maxX - minX;
  const h = maxY - minY;

  const onClick = (e: MouseEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    requestFocus(p.x, -p.y);
  };

  // 카메라 위치는 미니맵 범위 안으로 잘라서 방향만 표시한다
  const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
  const camX = clamp(camera.x, minX, maxX);
  const camY = clamp(camera.y, minY, maxY);

  return (
    <div className="rounded-lg bg-white/90 p-2 shadow-lg backdrop-blur">
      <div className="mb-1 flex items-center justify-between text-[11px] text-slate-600">
        <span className="font-semibold">미니맵</span>
        <span>N↑ · 클릭해서 이동</span>
      </div>
      <svg
        viewBox={`${minX} ${-maxY} ${w} ${h}`}
        className="block h-auto w-56 cursor-crosshair rounded bg-[#dfe5d8]"
        onClick={onClick}
      >
        {map.noFlyZones.map((z) => (
          <circle
            key={z.id}
            cx={z.center.x}
            cy={-z.center.y}
            r={z.radiusM}
            fill={palette.noFly}
            fillOpacity={0.18}
            stroke={palette.noFly}
            strokeWidth={3}
            strokeDasharray="8 6"
          />
        ))}
        {map.buildings.map((b) => (
          <polygon
            key={b.id}
            points={b.footprint.map(([x, y]) => `${x},${-y}`).join(' ')}
            fill={b.kind === 'APARTMENT' ? '#8b95a1' : palette.commercialWall}
            stroke="#475569"
            strokeWidth={1.5}
          />
        ))}
        {map.docks.map((d) => (
          <circle key={d.id} cx={d.position.x} cy={-d.position.y} r={9} fill={palette.dock} stroke="white" strokeWidth={2} />
        ))}
        {map.stations.map((s) => (
          <rect
            key={s.id}
            x={s.position.x - 9}
            y={-s.position.y - 9}
            width={18}
            height={18}
            fill={palette.station}
            stroke="white"
            strokeWidth={2}
          />
        ))}
        {map.stores.map((s) => (
          <circle key={s.id} cx={s.position.x} cy={-s.position.y} r={5} fill={palette.store} />
        ))}
        {/* 카메라 → 바라보는 지점 */}
        <line
          x1={camX}
          y1={-camY}
          x2={camera.targetX}
          y2={-camera.targetY}
          stroke="#0f172a"
          strokeWidth={2.5}
          strokeDasharray="6 4"
        />
        <circle cx={camera.targetX} cy={-camera.targetY} r={7} fill="none" stroke="#0f172a" strokeWidth={3} />
        <circle cx={camX} cy={-camY} r={8} fill="#0f172a" />
      </svg>
    </div>
  );
}
