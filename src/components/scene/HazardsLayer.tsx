'use client';

import { Line } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { defaultConfig } from '@/sim/config';
import { defaultMap } from '@/sim/map/defaultMap';
import { stationPads } from '@/sim/map/pads';
import type { HazardSpec, HazardState } from '@/sim/hazards/types';
import { engine, useSimStore } from '@/store/simStore';
import { type ThreeTuple, enuToThree, vecToThree } from '../coords';
import { setLabelAnchor } from '../labels/labels';

const TFR_COLOR = '#f97316';
const OBSTACLE_COLOR = '#facc15';
const INTRUDER_COLOR = '#e11d48';

function ring(r: number, n = 64): ThreeTuple[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return [Math.cos(a) * r, 0, Math.sin(a) * r] as ThreeTuple;
  });
}

/** 임시 비행금지구역: 깜박이는 주황 원기둥 */
function Tfr({ spec }: { spec: Extract<HazardSpec, { kind: 'TFR' }> }) {
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  const h = defaultConfig.altitude.maxM;
  const pts = useMemo(() => ring(spec.radiusM), [spec.radiusM]);
  useFrame(({ clock }) => {
    if (mat.current) mat.current.opacity = 0.12 + 0.08 * Math.sin(clock.elapsedTime * 3);
  });
  return (
    <group position={enuToThree(spec.center.x, spec.center.y, 0)}>
      <mesh position={[0, h / 2, 0]}>
        <cylinderGeometry args={[spec.radiusM, spec.radiusM, h, 48, 1, true]} />
        <meshBasicMaterial ref={mat} color={TFR_COLOR} transparent opacity={0.15} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <Line points={pts} color={TFR_COLOR} lineWidth={3} position={[0, 0.5, 0]} dashed dashSize={8} gapSize={5} />
      <Line points={pts} color={TFR_COLOR} lineWidth={3} position={[0, h, 0]} dashed dashSize={8} gapSize={5} />
    </group>
  );
}

/** 미등록 장애물: 타워크레인 (탐지 전에는 반투명 — 사람에겐 보이지만 UTM 은 모른다) */
function Obstacle({ h }: { h: HazardState }) {
  const spec = h.spec as Extract<HazardSpec, { kind: 'OBSTACLE' }>;
  const known = !!h.discovered;
  const mastW = Math.max(3, spec.sizeM * 0.35);
  const boom = spec.sizeM * 3;
  return (
    <group position={enuToThree(spec.center.x, spec.center.y, 0)}>
      {/* 실제 충돌 판정 범위 */}
      <mesh position={[0, spec.heightM / 2, 0]}>
        <boxGeometry args={[spec.sizeM, spec.heightM, spec.sizeM]} />
        <meshBasicMaterial color={known ? OBSTACLE_COLOR : '#a3a3a3'} transparent opacity={known ? 0.12 : 0.08} depthWrite={false} />
      </mesh>
      <mesh position={[0, spec.heightM / 2, 0]} castShadow>
        <boxGeometry args={[mastW, spec.heightM, mastW]} />
        <meshStandardMaterial color={OBSTACLE_COLOR} transparent={!known} opacity={known ? 1 : 0.55} />
      </mesh>
      <mesh position={[boom / 4, spec.heightM - 2, 0]} castShadow>
        <boxGeometry args={[boom, 2.5, 2.5]} />
        <meshStandardMaterial color={OBSTACLE_COLOR} transparent={!known} opacity={known ? 1 : 0.55} />
      </mesh>
      <mesh position={[0, spec.heightM + 1.5, 0]}>
        <sphereGeometry args={[1.5, 12, 12]} />
        <meshStandardMaterial color="#ef4444" emissive="#ef4444" emissiveIntensity={known ? 2 : 0.3} />
      </mesh>
    </group>
  );
}

/** 비협조 비행체: 위치는 매 프레임 엔진에서 읽는다 */
function Intruder({ h }: { h: HazardState }) {
  const g = useRef<THREE.Group>(null);
  const spec = h.spec as Extract<HazardSpec, { kind: 'INTRUDER' }>;
  const yaw = (-spec.headingDeg * Math.PI) / 180;
  const bubble = defaultConfig.hazards.nearMissM;
  useFrame(() => {
    const live = engine.getSnapshot().hazards.find((x) => x.id === h.id);
    const p = live?.position;
    if (!p || !g.current) return;
    g.current.position.set(p.x, p.z, -p.y);
    setLabelAnchor(`hazard:${h.id}`, p.x, p.z + 14, -p.y);
  });
  return (
    <group ref={g} position={vecToThree(h.position ?? { ...spec.start, z: spec.altitudeM })}>
      <group rotation={[0, yaw, 0]}>
        {/* 헬기 모양: 몸체 + 꼬리 + 로터 */}
        <mesh castShadow>
          <capsuleGeometry args={[2.2, 5, 6, 12]} />
          <meshStandardMaterial color={INTRUDER_COLOR} />
        </mesh>
        <mesh position={[0, 0.5, 6]}>
          <boxGeometry args={[0.8, 0.8, 8]} />
          <meshStandardMaterial color={INTRUDER_COLOR} />
        </mesh>
        <mesh position={[0, 2.8, 0]}>
          <boxGeometry args={[16, 0.2, 0.8]} />
          <meshStandardMaterial color="#1f2937" />
        </mesh>
      </group>
      {/* 근접(NMAC) 판정 구 */}
      <mesh>
        <sphereGeometry args={[bubble, 20, 14]} />
        <meshBasicMaterial color={INTRUDER_COLOR} wireframe transparent opacity={0.25} />
      </mesh>
      {/* 진행 방향 */}
      <Line points={[[0, 0, 0], [Math.sin(-yaw) * -60, 0, Math.cos(-yaw) * -60]]} color={INTRUDER_COLOR} lineWidth={2} dashed dashSize={4} gapSize={3} />
    </group>
  );
}

/** 폐쇄된 스테이션: 패드 위 빨간 X */
function StationClosed({ stationId }: { stationId: string }) {
  const st = defaultMap.stations.find((s) => s.id === stationId);
  if (!st) return null;
  return (
    <>
      {stationPads(st).map((p, i) => (
        <group key={i} position={vecToThree({ ...p, z: 1 })}>
          {[Math.PI / 4, -Math.PI / 4].map((r) => (
            <mesh key={r} rotation={[0, r, 0]}>
              <boxGeometry args={[14, 0.8, 1.6]} />
              <meshBasicMaterial color="#dc2626" />
            </mesh>
          ))}
        </group>
      ))}
    </>
  );
}

export function HazardsLayer() {
  const hazards = useSimStore((s) => s.hazards);
  return (
    <>
      {hazards
        .filter((h) => h.status === 'ACTIVE')
        .map((h) => {
          switch (h.spec.kind) {
            case 'TFR':
              return <Tfr key={h.id} spec={h.spec} />;
            case 'OBSTACLE':
              return <Obstacle key={h.id} h={h} />;
            case 'INTRUDER':
              return <Intruder key={h.id} h={h} />;
            case 'STATION_CLOSED':
              return <StationClosed key={h.id} stationId={h.spec.stationId} />;
            default:
              return null;
          }
        })}
    </>
  );
}
