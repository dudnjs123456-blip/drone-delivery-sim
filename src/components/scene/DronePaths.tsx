'use client';

import { Line } from '@react-three/drei';
import { useMemo } from 'react';
import type { Vec3 } from '@/sim/types';
import { useSimStore } from '@/store/simStore';
import { useViewStore } from '@/store/viewStore';
import { type ThreeTuple, vecToThree } from '../coords';
import { routeConflicts } from '../routeConflicts';

function PathLine({
  path,
  color,
  width = 2.5,
  dashed = false,
  opacity = 1,
}: {
  path: readonly Vec3[];
  color: string;
  width?: number;
  dashed?: boolean;
  opacity?: number;
}) {
  const points = useMemo<ThreeTuple[]>(() => path.map(vecToThree), [path]);
  return (
    <Line
      points={points}
      color={color}
      lineWidth={width}
      dashed={dashed}
      dashSize={6}
      gapSize={4}
      transparent={opacity < 1}
      opacity={opacity}
    />
  );
}

/** 웨이포인트 (평활화 후 꺾이는 점) */
function Waypoints({ path, color }: { path: readonly Vec3[]; color: string }) {
  return (
    <>
      {path.slice(1, -1).map((p, i) => (
        <mesh key={i} position={vecToThree(p)}>
          <sphereGeometry args={[1.6, 12, 12]} />
          <meshBasicMaterial color={color} />
        </mesh>
      ))}
    </>
  );
}

/** 경로 검증: 실제 장애물 침범 지점 (정상이라면 없어야 한다) */
function ConflictMarkers({ path }: { path: readonly Vec3[] }) {
  return (
    <>
      {routeConflicts(path).map((c) => (
        <mesh key={c.id} position={vecToThree(c.at)}>
          <sphereGeometry args={[3, 16, 16]} />
          <meshBasicMaterial color="#dc2626" transparent opacity={0.85} />
        </mesh>
      ))}
    </>
  );
}

export function DronePaths() {
  const drones = useSimStore((s) => s.drones);
  const preview = useSimStore((s) => s.preview);
  const showRawPath = useViewStore((s) => s.showRawPath);
  const anyIdle = drones.some((d) => d.phase === 'IDLE');

  return (
    <>
      {drones
        .filter((d) => d.path.length >= 2)
        .map((d) => {
          const returning = d.phase === 'RETURN';
          const color = returning ? '#475569' : '#0284c7';
          return (
            <group key={d.id}>
              <PathLine path={d.path} color={color} dashed={returning} />
              <Waypoints path={d.path} color={color} />
              {showRawPath && d.route && d.route.rawPath.length > 2 && (
                <PathLine path={d.route.rawPath} color="#a855f7" width={1.2} opacity={0.7} />
              )}
              <ConflictMarkers path={d.path} />
            </group>
          );
        })}

      {/* 출발 전 미리보기: 대기 중인 드론이 있을 때만 */}
      {anyIdle && preview?.result.ok && (
        <group>
          <PathLine path={preview.fullPath} color="#f97316" width={2} dashed opacity={0.9} />
          <Waypoints path={preview.fullPath} color="#f97316" />
          {showRawPath && preview.result.rawPath.length > 2 && (
            <PathLine path={preview.result.rawPath} color="#a855f7" width={1.2} opacity={0.7} />
          )}
        </group>
      )}
    </>
  );
}
