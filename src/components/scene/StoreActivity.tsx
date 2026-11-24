'use client';

import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { defaultConfig } from '@/sim/config';
import { defaultMap } from '@/sim/map/defaultMap';
import { dockShelfPoint, pointAlongRunnerPath, runnerPath } from '@/sim/orders/firstMile';
import { polygonCentroid } from '@/sim/util/geometry';
import type { Vec3 } from '@/sim/types';
import { engine, runner as simRunner, useSimStore } from '@/store/simStore';
import { setLabelAnchor } from '../labels/labels';

/** 사람·상자는 단지 규모에서 너무 작아 렌더링만 키운다 (드론과 같은 이유) */
const PERSON_SCALE = 4;
const BOX = 1.6;
const MAX_SHOWN = 12;

const COOK_COLOR = new THREE.Color('#f97316');
const DONE_COLOR = new THREE.Color('#facc15');

/** 가게 앞 카운터: 건물 바깥 방향과 그 옆 방향 */
function storeFrame(storeId: string) {
  const st = defaultMap.stores.find((s) => s.id === storeId)!;
  const b = defaultMap.buildings.find((x) => x.id === st.buildingId)!;
  const [cx, cy] = polygonCentroid(b.footprint);
  let ox = st.position.x - cx;
  let oy = st.position.y - cy;
  const l = Math.hypot(ox, oy) || 1;
  ox /= l;
  oy /= l;
  return { base: st.position, out: { x: ox, y: oy }, side: { x: -oy, y: ox } };
}

const at = (base: Vec3, out: { x: number; y: number }, side: { x: number; y: number }, o: number, s: number, z: number): [number, number, number] => [
  base.x + out.x * o + side.x * s,
  z,
  -(base.y + out.y * o + side.y * s),
];

/** 조리 중(주황, 진행할수록 노랗게·커짐) / 포장 중·완료(갈색 상자) */
function Kitchen({ storeId }: { storeId: string }) {
  const k = useSimStore((s) => s.kitchens.find((x) => x.storeId === storeId));
  const f = useMemo(() => storeFrame(storeId), [storeId]);
  if (!k) return null;
  const cooking = k.cooking.slice(0, MAX_SHOWN);
  const boxes = Math.min(MAX_SHOWN, k.packing + k.ready);
  const color = new THREE.Color();
  return (
    <group>
      {/* 조리대 */}
      <mesh position={at(f.base, f.out, f.side, 4, 0, 0.5)} receiveShadow>
        <boxGeometry args={[6, 1, 6]} />
        <meshStandardMaterial color="#e7e5e4" />
      </mesh>
      {cooking.map((p, i) => {
        const h = BOX * (0.5 + p * 0.7);
        color.copy(COOK_COLOR).lerp(DONE_COLOR, p);
        return (
          <mesh key={i} position={at(f.base, f.out, f.side, 6 + Math.floor(i / 4) * 2.2, (i % 4) * 2.2 - 3.3, h / 2)}>
            <boxGeometry args={[BOX, h, BOX]} />
            <meshStandardMaterial color={`#${color.getHexString()}`} emissive={`#${color.getHexString()}`} emissiveIntensity={0.6} />
          </mesh>
        );
      })}
      {Array.from({ length: boxes }, (_, i) => (
        <mesh key={`b${i}`} position={at(f.base, f.out, f.side, 3.5, 4.5 + (i % 3) * 2, BOX / 2 + 1 + Math.floor(i / 3) * BOX)} castShadow>
          <boxGeometry args={[BOX, BOX * 0.9, BOX]} />
          <meshStandardMaterial color={i < k.packing ? '#d6d3d1' : '#a16207'} />
        </mesh>
      ))}
    </group>
  );
}

/** 운반 직원: 경로는 순수 함수로 계산하고 위치만 매 프레임 갱신한다 */
function Runner({ id, storeId }: { id: string; storeId: string }) {
  const g = useRef<THREE.Group>(null);
  const boxes = useRef<THREE.Group>(null);
  const path = useMemo(() => runnerPath(defaultMap, defaultMap.stores.find((s) => s.id === storeId)!), [storeId]);
  const tint = useMemo(() => ['#2563eb', '#16a34a', '#9333ea', '#0891b2'][defaultMap.stores.findIndex((s) => s.id === storeId) % 4], [storeId]);
  const last = useRef(new THREE.Vector3());

  useFrame(() => {
    const r = engine.getSnapshot().runners.find((x) => x.id === id);
    if (!r || !g.current) return;
    const dt = defaultConfig.time.fixedDtSec;
    // 50ms 스텝 사이도 부드럽게: 엔진 시각 + 보간 비율
    const step = engine.getSnapshot().time / dt + simRunner.alpha;
    const span = Math.max(1, r.endStep - r.startStep);
    const f = r.phase === 'IDLE' ? 0 : Math.min(1, Math.max(0, (step - r.startStep) / span));
    const p = pointAlongRunnerPath(path, r.phase === 'BACK' ? 1 - f : f);
    g.current.position.set(p.x, p.z, -p.y);
    // 진행 방향을 바라본다
    const dx = p.x - last.current.x;
    const dz = -p.y - last.current.z;
    if (Math.hypot(dx, dz) > 0.01) g.current.rotation.y = Math.atan2(dx, dz);
    last.current.set(p.x, p.z, -p.y);
    if (boxes.current) {
      boxes.current.children.forEach((c, i) => {
        c.visible = i < r.orderIds.length;
      });
    }
    setLabelAnchor(`runner:${id}`, p.x, p.z + 11, -p.y);
  });

  return (
    <group ref={g} scale={PERSON_SCALE}>
      <mesh position={[0, 0.55, 0]} castShadow>
        <capsuleGeometry args={[0.22, 0.6, 4, 10]} />
        <meshStandardMaterial color={tint} />
      </mesh>
      <mesh position={[0, 1.2, 0]}>
        <sphereGeometry args={[0.17, 12, 12]} />
        <meshStandardMaterial color="#fcd34d" />
      </mesh>
      {/* 든 상자 (최대 4개) */}
      <group ref={boxes} position={[0, 0.7, 0.3]}>
        {[0, 1, 2, 3].map((i) => (
          <mesh key={i} position={[0, i * 0.22, 0]} visible={false}>
            <boxGeometry args={[0.35, 0.2, 0.3]} />
            <meshStandardMaterial color="#a16207" />
          </mesh>
        ))}
      </group>
    </group>
  );
}

/** 도크 적재 선반: 드론을 기다리는 화물 */
function DockShelf({ dockId }: { dockId: string }) {
  const n = useSimStore((s) => s.orders.shelfByDock[dockId] ?? 0);
  const p = useMemo(() => dockShelfPoint(defaultMap, defaultMap.docks.find((d) => d.id === dockId)!), [dockId]);
  const shown = Math.min(16, n);
  return (
    <group position={[p.x, p.z, -p.y]}>
      <mesh position={[0, 0.3, 0]} receiveShadow>
        <boxGeometry args={[10, 0.6, 4]} />
        <meshStandardMaterial color="#78716c" />
      </mesh>
      {Array.from({ length: shown }, (_, i) => (
        <mesh key={i} position={[((i % 4) - 1.5) * 2.2, 0.6 + BOX / 2 + Math.floor(i / 4) * BOX, 0]} castShadow>
          <boxGeometry args={[BOX, BOX * 0.9, BOX]} />
          <meshStandardMaterial color="#a16207" />
        </mesh>
      ))}
    </group>
  );
}

export function StoreActivity() {
  const runners = useSimStore((s) => s.runners.map((r) => `${r.id}|${r.storeId}`).join(','));
  return (
    <>
      {defaultMap.stores.map((s) => (
        <Kitchen key={s.id} storeId={s.id} />
      ))}
      {runners
        .split(',')
        .filter(Boolean)
        .map((k) => {
          const [id, storeId] = k.split('|');
          return <Runner key={id} id={id} storeId={storeId} />;
        })}
      {defaultMap.docks.map((d) => (
        <DockShelf key={d.id} dockId={d.id} />
      ))}
    </>
  );
}
