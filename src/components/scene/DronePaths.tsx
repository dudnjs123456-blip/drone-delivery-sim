'use client';

import { Line } from '@react-three/drei';
import { useMemo } from 'react';
import type { Vec3 } from '@/sim/types';
import { useSimStore } from '@/store/simStore';
import { type ThreeTuple, vecToThree } from '../coords';
import { routeConflicts } from '../routeConflicts';

function PathLine({ path, returning }: { path: readonly Vec3[]; returning: boolean }) {
  const points = useMemo<ThreeTuple[]>(() => path.map(vecToThree), [path]);
  const conflicts = routeConflicts(path);
  return (
    <>
      <Line
        points={points}
        color={returning ? '#475569' : '#0284c7'}
        lineWidth={2.5}
        dashed={returning}
        dashSize={6}
        gapSize={4}
      />
      {/* 침범 지점 표시 (M3 에서 우회 경로로 해결) */}
      {conflicts.map((c) => (
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
  return (
    <>
      {drones
        .filter((d) => d.path.length >= 2)
        .map((d) => (
          <PathLine key={d.id} path={d.path} returning={d.phase === 'RETURN'} />
        ))}
    </>
  );
}
