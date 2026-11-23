'use client';

import { OrbitControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { type ComponentRef, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { MapData } from '@/sim/types';
import { engine, runner } from '@/store/simStore';
import { useViewStore } from '@/store/viewStore';
import { enuToThree, threeToEnu } from '../coords';

type Controls = ComponentRef<typeof OrbitControls>;

interface Pose {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

const TOP_HEIGHT = 820;
const REPORT_INTERVAL_SEC = 0.1;

/** OrbitControls + 3D/상단 시점 전환 애니메이션 + 미니맵용 카메라 위치 보고 */
export function CameraRig({ map }: { map: MapData }) {
  const controls = useRef<Controls>(null);
  const camera = useThree((s) => s.camera);
  const viewMode = useViewStore((s) => s.viewMode);
  const focusRequest = useViewStore((s) => s.focusRequest);
  const setCamera = useViewStore((s) => s.setCamera);
  const followDroneId = useViewStore((s) => s.followDroneId);
  const followTmp = useMemo(() => ({ v: new THREE.Vector3(), p: { x: 0, y: 0, z: 0 } }), []);

  const anim = useRef<Pose | null>(null);
  const reportAcc = useRef(0);

  const cx = (map.bounds.minX + map.bounds.maxX) / 2;
  const cy = (map.bounds.minY + map.bounds.maxY) / 2;
  // 매 렌더마다 새 배열을 넘기면 목표점이 초기화되므로 고정한다
  const initialTarget = useMemo(() => enuToThree(cx, cy, 0), [cx, cy]);

  // 시점 전환
  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    if (viewMode === 'TOP') {
      // 상단 시점: 단지 전체를 북쪽이 위로 오게 내려다본다.
      // 정확히 수직이면 OrbitControls 가 방위각을 정하지 못하므로 남쪽으로 아주 조금 비켜 둔다
      const t = new THREE.Vector3(...enuToThree(cx, cy, 0));
      anim.current = { position: new THREE.Vector3(t.x, TOP_HEIGHT, t.z + 1), target: t };
      c.enableRotate = false;
    } else {
      anim.current = {
        position: new THREE.Vector3(...enuToThree(cx - 330, cy - 380, 300)),
        target: new THREE.Vector3(...enuToThree(cx, cy, 0)),
      };
      c.enableRotate = true;
    }
  }, [viewMode, cx, cy]);

  // 미니맵 클릭 → 그 지점으로 이동 (카메라와 목표점의 상대 위치는 유지)
  useEffect(() => {
    const c = controls.current;
    if (!c || !focusRequest) return;
    const target = new THREE.Vector3(...enuToThree(focusRequest.x, focusRequest.y, 0));
    const offset = camera.position.clone().sub(c.target);
    anim.current = { position: target.clone().add(offset), target };
  }, [focusRequest, camera]);

  useFrame((_, delta) => {
    const c = controls.current;
    if (!c) return;

    if (anim.current) {
      const k = 1 - Math.exp(-delta * 6);
      camera.position.lerp(anim.current.position, k);
      c.target.lerp(anim.current.target, k);
      c.update();
      if (camera.position.distanceTo(anim.current.position) < 0.5 && c.target.distanceTo(anim.current.target) < 0.5) {
        // 남은 오차가 방위각을 비틀지 않도록 마지막에 정확히 맞춘다
        camera.position.copy(anim.current.position);
        c.target.copy(anim.current.target);
        c.update();
        anim.current = null;
      }
    }

    // 드론 따라가기: 목표점을 드론 쪽으로 부드럽게 옮기고 카메라도 같은 만큼 이동
    if (followDroneId && !anim.current) {
      const d = engine.getSnapshot().drones.find((x) => x.id === followDroneId);
      if (d) {
        const p = runner.interpolatedPosition(d, followTmp.p);
        const k = 1 - Math.exp(-delta * 8);
        followTmp.v.set(p.x, p.z, -p.y).sub(c.target).multiplyScalar(k);
        c.target.add(followTmp.v);
        camera.position.add(followTmp.v);
        c.update();
      }
    }

    reportAcc.current += delta;
    if (reportAcc.current >= REPORT_INTERVAL_SEC) {
      reportAcc.current = 0;
      const p = threeToEnu(camera.position.x, camera.position.y, camera.position.z);
      const t = threeToEnu(c.target.x, c.target.y, c.target.z);
      const prev = useViewStore.getState().camera;
      if (Math.abs(prev.x - p.x) + Math.abs(prev.y - p.y) + Math.abs(prev.targetX - t.x) + Math.abs(prev.targetY - t.y) > 0.5) {
        setCamera({ x: p.x, y: p.y, targetX: t.x, targetY: t.y });
      }
    }
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      target={initialTarget}
      enableDamping
      dampingFactor={0.12}
      minDistance={20}
      maxDistance={1500}
      maxPolarAngle={Math.PI / 2 - 0.05}
      // 사용자가 조작을 시작하면 진행 중인 전환 애니메이션을 멈춘다
      onStart={() => {
        anim.current = null;
      }}
    />
  );
}
