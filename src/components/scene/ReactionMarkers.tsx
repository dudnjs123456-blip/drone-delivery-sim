'use client';

import { Line } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Vec3 } from '@/sim/types';
import { engine, useSimStore } from '@/store/simStore';
import { type ThreeTuple, vecToThree } from '../coords';
import { droneDisplayPos, simTimeNow } from '../scenePos';

/** 대응 사건이 난 뒤 드론 주위 고리를 보여 주는 시간 (시뮬레이션 s) */
const MARK_SEC = 10;
const color = { bad: '#dc2626', warn: '#f59e0b', good: '#10b981', info: '#64748b' };

/** 드론 주위에서 퍼지는 고리 (사건 직후일수록 크고 진하다) */
function Ring({ droneId, severity, since }: { droneId: string; severity: keyof typeof color; since: number }) {
  const g = useRef<THREE.Group>(null);
  const rings = useRef<THREE.Mesh[]>([]);
  const tmp = useMemo(() => ({ x: 0, y: 0, z: 0 }) as Vec3, []);
  useFrame(({ clock }) => {
    const d = engine.getSnapshot().drones.find((x) => x.id === droneId);
    if (!d || !g.current) return;
    const p = droneDisplayPos(d, tmp);
    g.current.position.set(p.x, p.z, -p.y);
    const age = simTimeNow() - since;
    const fade = Math.max(0, 1 - age / MARK_SEC);
    g.current.visible = fade > 0;
    rings.current.forEach((m, i) => {
      const ph = (clock.elapsedTime * 1.2 + i * 0.5) % 1;
      (m.material as THREE.MeshBasicMaterial).opacity = (1 - ph) * 0.8 * fade;
      const s = 6 + ph * 22;
      m.scale.set(s, s, s);
    });
  });
  return (
    <group ref={g}>
      {[0, 1].map((i) => (
        <mesh
          key={i}
          rotation={[-Math.PI / 2, 0, 0]}
          ref={(m) => {
            if (m) rings.current[i] = m;
          }}
        >
          <ringGeometry args={[0.85, 1, 40]} />
          <meshBasicMaterial color={color[severity]} transparent depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      ))}
      <mesh>
        <sphereGeometry args={[7, 20, 14]} />
        <meshBasicMaterial color={color[severity]} transparent opacity={0.12} depthWrite={false} />
      </mesh>
    </group>
  );
}

/** 버린 원래 경로: 빨간 점선 + 끝에 ✕ */
function Ghost({ path }: { path: Vec3[] }) {
  const pts = useMemo<ThreeTuple[]>(() => path.map(vecToThree), [path]);
  const end = pts[pts.length - 1];
  return (
    <group>
      <Line points={pts} color="#ef4444" lineWidth={3} dashed dashSize={5} gapSize={5} transparent opacity={0.85} />
      {[Math.PI / 4, -Math.PI / 4].map((r) => (
        <mesh key={r} position={end} rotation={[0, r, 0]}>
          <boxGeometry args={[10, 1.2, 1.2]} />
          <meshBasicMaterial color="#ef4444" />
        </mesh>
      ))}
    </group>
  );
}

export function ReactionMarkers() {
  const log = useSimStore((s) => s.hazardLog);
  const time = useSimStore((s) => s.time);
  const drones = useSimStore((s) => s.drones);

  // 드론별 가장 최근 사건 (MARK_SEC 이내)
  const recent = new Map<string, { severity: keyof typeof color; t: number }>();
  for (const e of log) {
    if (!e.droneId || e.severity === 'info' || time - e.t > MARK_SEC) continue;
    recent.set(e.droneId, { severity: e.severity, t: e.t });
  }

  return (
    <>
      {[...recent].map(([id, r]) => (
        <Ring key={`${id}-${r.t}`} droneId={id} severity={r.severity} since={r.t} />
      ))}
      {drones
        .filter((d) => d.ghostPath && d.ghostUntil !== null && time < d.ghostUntil)
        .map((d) => (
          <Ghost key={`${d.id}-${d.ghostUntil}`} path={d.ghostPath!} />
        ))}
    </>
  );
}
