'use client';

import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { engine, runner, useSimStore } from '@/store/simStore';
import { useViewStore } from '@/store/viewStore';
import type { Vec3 } from '@/sim/types';
import { setLabelAnchor } from '../labels/labels';
import { isAirborne, phaseColor } from '../phase';

/** 실제 드론(약 1.2m)은 단지 규모에서 너무 작아 보여 렌더링만 키운다 */
export const DRONE_RENDER_SCALE = 6;
const ROTOR_SPIN_RAD_S = 60;
const LABEL_OFFSET_M = 9;

/**
 * 드론 모델을 부품별 InstancedMesh 로 그린다.
 * 드론마다 메시를 만들면 드론 수 × 부품 수(16개)만큼 draw call 이 생기는데,
 * 인스턴싱하면 드론 수와 관계없이 부품 종류 수(7개)만큼만 그린다.
 * 기준 자세: 앞쪽 = -Z (북쪽), 위 = +Y.
 */
const ARM_ANGLES = [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4];
const ROTOR_POS = ARM_ANGLES.map((a) => new THREE.Vector3(Math.cos(a) * 0.55, 0.22, Math.sin(a) * 0.55));

interface PartSpec {
  key: string;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** 드론 좌표계 기준 부품 변환 (드론 하나에 여러 개일 수 있다) */
  locals: THREE.Matrix4[];
  castShadow?: boolean;
  /** 회전하는 로터 날개 */
  spin?: boolean;
  /** 비행 단계 색 (instanceColor) */
  phaseColored?: boolean;
}

const T = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);

function makeParts(): PartSpec[] {
  const std = (color: string) => new THREE.MeshStandardMaterial({ color });
  return [
    { key: 'body', geometry: new THREE.BoxGeometry(0.45, 0.18, 0.6), material: std('#1e293b'), locals: [T(0, 0.15, 0)], castShadow: true },
    { key: 'nose', geometry: new THREE.BoxGeometry(0.2, 0.06, 0.06), material: std('#f8fafc'), locals: [T(0, 0.2, -0.32)] },
    { key: 'cargo', geometry: new THREE.BoxGeometry(0.28, 0.2, 0.28), material: std('#d97706'), locals: [T(0, -0.05, 0)], castShadow: true },
    {
      key: 'arm',
      geometry: new THREE.BoxGeometry(0.55, 0.04, 0.05),
      material: std('#334155'),
      locals: ARM_ANGLES.map((a) =>
        T(Math.cos(a) * 0.275, 0.15, Math.sin(a) * 0.275).multiply(new THREE.Matrix4().makeRotationY(-a)),
      ),
    },
    {
      key: 'ring',
      geometry: new THREE.RingGeometry(0.24, 0.27, 24).rotateX(-Math.PI / 2),
      material: new THREE.MeshBasicMaterial({ color: '#94a3b8', side: THREE.DoubleSide, transparent: true, opacity: 0.6 }),
      locals: ROTOR_POS.map((p) => T(p.x, p.y, p.z)),
    },
    {
      key: 'blade',
      geometry: new THREE.BoxGeometry(0.5, 0.01, 0.05),
      material: std('#e2e8f0'),
      locals: ROTOR_POS.map((p) => T(p.x, p.y, p.z)),
      spin: true,
    },
    {
      key: 'led',
      geometry: new THREE.SphereGeometry(0.09, 12, 12),
      // 색은 instanceColor 로 준다 (material.color 와 곱해지므로 흰색)
      material: new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 0.6 }),
      locals: [T(0, 0.27, 0)],
      phaseColored: true,
    },
  ];
}

export function Drones() {
  const count = useSimStore((s) => s.drones.length);
  const parts = useMemo(() => makeParts(), []);
  const meshes = useRef<(THREE.InstancedMesh | null)[]>([]);
  // 매 프레임 바뀌는 값과 재사용 버퍼는 ref 에 둔다 (useFrame 안에서만 읽고 쓴다)
  const frame = useRef({
    spin: new Float32Array(256),
    p: { x: 0, y: 0, z: 0 } as Vec3,
    m: new THREE.Matrix4(),
    w: new THREE.Matrix4(),
    s: new THREE.Matrix4(),
    q: new THREE.Quaternion(),
    e: new THREE.Euler(0, 0, 0, 'YXZ'),
    pos: new THREE.Vector3(),
    scl: new THREE.Vector3(DRONE_RENDER_SCALE, DRONE_RENDER_SCALE, DRONE_RENDER_SCALE),
    c: new THREE.Color(),
  });

  // 부품 지오메트리·재질 정리
  useEffect(
    () => () => {
      for (const p of parts) {
        p.geometry.dispose();
        p.material.dispose();
      }
    },
    [parts],
  );

  useFrame((_, delta) => {
    const tmp = frame.current;
    const spin = tmp.spin;
    const drones = engine.getSnapshot().drones;
    const n = Math.min(drones.length, count);
    const view = useViewStore.getState();
    // 1인칭으로 타고 있는 드론은 카메라를 가리지 않게 숨긴다
    const hiddenId = view.viewMode === 'FPV' ? view.fpvDroneId : null;
    for (let i = 0; i < n; i++) {
      const d = drones[i];
      const p = runner.interpolatedPosition(d, tmp.p);
      const hs = Math.hypot(d.velocity.x, d.velocity.y);
      // 방위(yaw)를 먼저, 진행 방향 기울기(pitch)는 기체 기준
      tmp.e.set(-Math.min(0.25, hs * 0.02), -d.headingRad, 0, 'YXZ');
      tmp.q.setFromEuler(tmp.e);
      tmp.pos.set(p.x, p.z, -p.y);
      tmp.w.compose(tmp.pos, tmp.q, tmp.scl);
      if (d.id === hiddenId) tmp.w.makeScale(0, 0, 0);

      const airborne = isAirborne(d.phase);
      if (airborne && !runner.paused) spin[i] += ROTOR_SPIN_RAD_S * delta * Math.min(runner.speed, 3);

      for (let k = 0; k < parts.length; k++) {
        const part = parts[k];
        const mesh = meshes.current[k];
        if (!mesh) continue;
        for (let j = 0; j < part.locals.length; j++) {
          tmp.m.multiplyMatrices(tmp.w, part.locals[j]);
          if (part.key === 'cargo' && d.payloadKg <= 0) tmp.m.makeScale(0, 0, 0);
          if (part.spin) tmp.m.multiply(tmp.s.makeRotationY(spin[i] + j));
          mesh.setMatrixAt(i * part.locals.length + j, tmp.m);
        }
        if (part.phaseColored) mesh.setColorAt(i, tmp.c.set(phaseColor[d.phase]));
      }
      setLabelAnchor(`drone:${d.id}`, p.x, p.z + LABEL_OFFSET_M, -p.y);
    }
    for (let k = 0; k < parts.length; k++) {
      const mesh = meshes.current[k];
      if (!mesh) continue;
      mesh.count = n * parts[k].locals.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  });

  if (count === 0) return null;
  return (
    <>
      {parts.map((part, k) => (
        <instancedMesh
          // 드론 수가 바뀌면 버퍼 크기가 달라지므로 새로 만든다
          key={`${part.key}-${count}`}
          ref={(m) => {
            meshes.current[k] = m;
          }}
          args={[part.geometry, part.material, count * part.locals.length]}
          castShadow={part.castShadow}
          // 인스턴스가 단지 전체에 흩어져 있어 기본 경계구로는 잘못 잘린다
          frustumCulled={false}
        />
      ))}
    </>
  );
}
