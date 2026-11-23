'use client';

import { useFrame } from '@react-three/fiber';
import { useRef, useState } from 'react';
import * as THREE from 'three';
import { engine, runner, useSimStore } from '@/store/simStore';
import type { Vec3 } from '@/sim/types';
import { setLabelAnchor } from '../labels/labels';
import { isAirborne, phaseColor } from '../phase';

/** 실제 드론(약 1.2m)은 단지 규모에서 너무 작아 보여 렌더링만 키운다 */
export const DRONE_RENDER_SCALE = 6;
const ROTOR_SPIN_RAD_S = 60;
const LABEL_OFFSET_M = 9;

interface DroneParts {
  root: THREE.Group;
  rotors: THREE.Object3D[];
  led: THREE.MeshStandardMaterial;
}

const ARM_ANGLES = [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4];

function DroneModel({ id, registry }: { id: string; registry: Map<string, DroneParts> }) {
  const parts = useRef<Partial<DroneParts>>({ rotors: [] });
  const tryRegister = () => {
    const p = parts.current;
    if (p.root && p.led && p.rotors?.length === 4) registry.set(id, p as DroneParts);
  };

  return (
    <group
      ref={(g) => {
        if (!g) return;
        parts.current.root = g;
        tryRegister();
        return () => {
          registry.delete(id);
        };
      }}
      scale={DRONE_RENDER_SCALE}
    >
      {/* 몸체 (앞쪽 = -Z = 북쪽이 기준 자세) */}
      <mesh castShadow position={[0, 0.15, 0]}>
        <boxGeometry args={[0.45, 0.18, 0.6]} />
        <meshStandardMaterial color="#1e293b" />
      </mesh>
      {/* 앞쪽 표시 */}
      <mesh position={[0, 0.2, -0.32]}>
        <boxGeometry args={[0.2, 0.06, 0.06]} />
        <meshStandardMaterial color="#f8fafc" />
      </mesh>
      {/* 상태 LED */}
      <mesh position={[0, 0.27, 0]}>
        <sphereGeometry args={[0.09, 12, 12]} />
        <meshStandardMaterial
          ref={(m) => {
            if (m) {
              parts.current.led = m;
              tryRegister();
            }
          }}
          color="#64748b"
          emissive="#64748b"
          emissiveIntensity={2}
        />
      </mesh>
      {/* 화물 */}
      <mesh position={[0, -0.05, 0]} castShadow>
        <boxGeometry args={[0.28, 0.2, 0.28]} />
        <meshStandardMaterial color="#d97706" />
      </mesh>
      {ARM_ANGLES.map((a, i) => {
        const x = Math.cos(a) * 0.55;
        const z = Math.sin(a) * 0.55;
        return (
          <group key={i}>
            <mesh position={[x / 2, 0.15, z / 2]} rotation={[0, -a, 0]}>
              <boxGeometry args={[0.55, 0.04, 0.05]} />
              <meshStandardMaterial color="#334155" />
            </mesh>
            <group
              position={[x, 0.22, z]}
              ref={(g) => {
                if (g) {
                  parts.current.rotors![i] = g;
                  tryRegister();
                }
              }}
            >
              <mesh>
                <boxGeometry args={[0.5, 0.01, 0.05]} />
                <meshStandardMaterial color="#e2e8f0" />
              </mesh>
              <mesh rotation={[-Math.PI / 2, 0, 0]}>
                <ringGeometry args={[0.24, 0.27, 24]} />
                <meshBasicMaterial color="#94a3b8" side={THREE.DoubleSide} transparent opacity={0.6} />
              </mesh>
            </group>
          </group>
        );
      })}
    </group>
  );
}

/** 드론 목록은 10Hz UI 상태로, 위치·자세는 매 프레임 엔진 스냅샷에서 직접 갱신한다 */
export function Drones() {
  const idsKey = useSimStore((s) => s.drones.map((d) => d.id).join(','));
  const ids = idsKey ? idsKey.split(',') : [];
  // 렌더 중 ref.current 를 읽지 않도록 한 번 만든 객체를 state 로 보관한다
  const [registry] = useState(() => new Map<string, DroneParts>());
  const [tmp] = useState<Vec3>(() => ({ x: 0, y: 0, z: 0 }));
  const [color] = useState(() => new THREE.Color());

  useFrame((_, delta) => {
    for (const d of engine.getSnapshot().drones) {
      const parts = registry.get(d.id);
      if (!parts) continue;
      const p = runner.interpolatedPosition(d, tmp);
      parts.root.position.set(p.x, p.z, -p.y);
      // 방위(yaw)를 먼저, 기울기(pitch)는 기체 기준으로 적용
      parts.root.rotation.order = 'YXZ';
      parts.root.rotation.y = -d.headingRad;
      // 진행 방향으로 살짝 기울인다 (시각 효과)
      const hs = Math.hypot(d.velocity.x, d.velocity.y);
      parts.root.rotation.x = -Math.min(0.25, hs * 0.02);

      const airborne = isAirborne(d.phase);
      const spin = airborne ? ROTOR_SPIN_RAD_S * delta * Math.min(runner.speed, 3) : 0;
      if (!runner.paused) for (const r of parts.rotors) r.rotation.y += spin;

      color.set(phaseColor[d.phase]);
      parts.led.color.copy(color);
      parts.led.emissive.copy(color);

      setLabelAnchor(`drone:${d.id}`, p.x, p.z + LABEL_OFFSET_M, -p.y);
    }
  });

  return (
    <>
      {ids.map((id) => (
        <DroneModel key={id} id={id} registry={registry} />
      ))}
    </>
  );
}
