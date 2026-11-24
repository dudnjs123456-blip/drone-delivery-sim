'use client';

import { Line } from '@react-three/drei';
import { useMemo } from 'react';
import * as THREE from 'three';
import { defaultMap } from '@/sim/map/defaultMap';
import { dockLaunchPads, dockParking, stationPads } from '@/sim/map/pads';
import type { Dock, NoFlyZone, Station, Store } from '@/sim/types';
import { type ThreeTuple, enuToThree, vecToThree } from '../coords';
import { palette } from './palette';

/** 원형 패드 + 위치 표시용 기둥과 비컨 */
function Pad({ position, color, radius }: { position: ThreeTuple; color: string; radius: number }) {
  return (
    <group position={position}>
      <mesh position={[0, 0.2, 0]} receiveShadow>
        <cylinderGeometry args={[radius, radius, 0.4, 32]} />
        <meshStandardMaterial color={color} />
      </mesh>
      <mesh position={[0, 0.42, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[radius * 0.55, radius * 0.7, 32]} />
        <meshBasicMaterial color="white" />
      </mesh>
      <mesh position={[radius + 1, 3, 0]}>
        <cylinderGeometry args={[0.15, 0.15, 6, 8]} />
        <meshStandardMaterial color="#334155" />
      </mesh>
      <mesh position={[radius + 1, 6.3, 0]}>
        <sphereGeometry args={[0.6, 16, 16]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={1.5} />
      </mesh>
    </group>
  );
}

/** 도크: 옥상 양 끝 이착륙 패드 + 가운데 격납고(대기 칸) */
export function Docks({ docks }: { docks: Dock[] }) {
  return (
    <>
      {docks.map((d) => (
        <group key={d.id}>
          {dockLaunchPads(defaultMap, d).map((p, i) => (
            <Pad key={i} position={vecToThree(p)} color={palette.dock} radius={5} />
          ))}
          {/* 격납고 바닥 */}
          <mesh position={vecToThree({ ...d.position, z: d.position.z + 0.15 })} receiveShadow>
            <boxGeometry args={[17, 0.3, 17]} />
            <meshStandardMaterial color="#475569" />
          </mesh>
          {dockParking(defaultMap, d).map((p, i) => (
            <mesh key={i} position={vecToThree({ ...p, z: p.z + 0.32 })} rotation={[-Math.PI / 2, 0, 0]}>
              <ringGeometry args={[1.6, 1.9, 20]} />
              <meshBasicMaterial color="#cbd5e1" />
            </mesh>
          ))}
        </group>
      ))}
    </>
  );
}

export function Stations({ stations }: { stations: Station[] }) {
  return (
    <>
      {stations.map((s) => (
        <group key={s.id}>
          {stationPads(s).map((p, i) => (
            <Pad key={i} position={vecToThree(p)} color={palette.station} radius={6} />
          ))}
        </group>
      ))}
    </>
  );
}

export function Stores({ stores }: { stores: Store[] }) {
  return (
    <>
      {stores.map((s) => (
        <mesh key={s.id} position={enuToThree(s.position.x, s.position.y, 3)} castShadow>
          <boxGeometry args={[3, 6, 3]} />
          <meshStandardMaterial color={palette.store} />
        </mesh>
      ))}
    </>
  );
}

function NoFlyZoneMesh({ zone }: { zone: NoFlyZone }) {
  const h = zone.maxZ - zone.minZ;
  const circle = useMemo(() => {
    const pts: ThreeTuple[] = [];
    for (let i = 0; i <= 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      pts.push([Math.cos(a) * zone.radiusM, 0, Math.sin(a) * zone.radiusM]);
    }
    return pts;
  }, [zone.radiusM]);

  return (
    <group position={enuToThree(zone.center.x, zone.center.y, zone.minZ)}>
      <mesh position={[0, h / 2, 0]}>
        <cylinderGeometry args={[zone.radiusM, zone.radiusM, h, 48, 1, true]} />
        <meshBasicMaterial color={palette.noFly} transparent opacity={0.12} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <Line points={circle} color={palette.noFly} lineWidth={2} position={[0, 0.3, 0]} />
      <Line points={circle} color={palette.noFly} lineWidth={2} position={[0, h, 0]} />
    </group>
  );
}

export function NoFlyZones({ zones }: { zones: NoFlyZone[] }) {
  return (
    <>
      {zones.map((z) => (
        <NoFlyZoneMesh key={z.id} zone={z} />
      ))}
    </>
  );
}
