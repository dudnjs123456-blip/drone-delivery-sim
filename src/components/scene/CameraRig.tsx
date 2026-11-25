'use client';

import { OrbitControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { type ComponentRef, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { MapData } from '@/sim/types';
import { engine } from '@/store/simStore';
import { type ViewMode, useViewStore } from '@/store/viewStore';
import { enuToThree, threeToEnu } from '../coords';
import { droneDisplayPos, runnerDisplayPos } from '../scenePos';

type Controls = ComponentRef<typeof OrbitControls>;

interface Pose {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

const TOP_HEIGHT = 820;
const REPORT_INTERVAL_SEC = 0.1;
const ORBIT_FOV = 50;
/** 1인칭: 넓은 시야, 기체 앞쪽 약간 아래를 본다 */
const FPV_FOV = 75;
const FPV_PITCH = -0.12;
/** 기체 중심에서 카메라까지 (m): 위로, 앞으로 */
const FPV_UP = 0.6;
const FPV_FORWARD = 1.5;

/** 시야각·근평면 변경 (훅이 준 카메라 객체를 직접 고치지 않도록 함수로 분리) */
function setLens(cam: THREE.Camera, fov: number, near: number) {
  const c = cam as THREE.PerspectiveCamera;
  c.fov = fov;
  c.near = near;
  c.updateProjectionMatrix();
}

/** OrbitControls + 3D/상단/1인칭 시점 + 미니맵용 카메라 위치 보고 */
export function CameraRig({ map }: { map: MapData }) {
  const controls = useRef<Controls>(null);
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const viewMode = useViewStore((s) => s.viewMode);
  const focusRequest = useViewStore((s) => s.focusRequest);
  const setCamera = useViewStore((s) => s.setCamera);
  const followDroneId = useViewStore((s) => s.followDroneId);
  const tmp = useMemo(() => ({ v: new THREE.Vector3(), p: { x: 0, y: 0, z: 0 }, look: new THREE.Vector3() }), []);

  const anim = useRef<Pose | null>(null);
  const reportAcc = useRef(0);
  const prevMode = useRef<ViewMode>(viewMode);
  /** 1인칭: 부드럽게 따라가는 방위 + 마우스로 둘러본 오프셋 */
  const fpv = useRef({ yaw: 0, init: false, lookYaw: 0, lookPitch: 0 });

  const cx = (map.bounds.minX + map.bounds.maxX) / 2;
  const cy = (map.bounds.minY + map.bounds.maxY) / 2;
  // 매 렌더마다 새 배열을 넘기면 목표점이 초기화되므로 고정한다
  const initialTarget = useMemo(() => enuToThree(cx, cy, 0), [cx, cy]);

  // 시점 전환
  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const from = prevMode.current;
    prevMode.current = viewMode;
    if (viewMode === 'FPV') {
      c.enabled = false;
      anim.current = null;
      fpv.current = { yaw: 0, init: false, lookYaw: 0, lookPitch: 0 };
      setLens(camera, FPV_FOV, 0.3);
      return;
    }
    c.enabled = true;
    setLens(camera, ORBIT_FOV, 1);
    if (from === 'FPV' && viewMode === '3D') {
      // 1인칭에서 나오면 그 드론 뒤쪽 위에서 바라본다
      const t = camera.position.clone();
      tmp.look.set(0, 0, -1).applyQuaternion(camera.quaternion).setY(0).normalize();
      anim.current = { position: t.clone().addScaledVector(tmp.look, -120).add(new THREE.Vector3(0, 70, 0)), target: t };
      c.target.copy(t);
      c.enableRotate = true;
      return;
    }
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
  }, [viewMode, cx, cy, camera, tmp]);

  // 1인칭: 드래그로 둘러보기, 더블클릭으로 정면
  useEffect(() => {
    if (viewMode !== 'FPV') return;
    const el = gl.domElement;
    let drag: { x: number; y: number } | null = null;
    const down = (e: PointerEvent) => {
      drag = { x: e.clientX, y: e.clientY };
    };
    const move = (e: PointerEvent) => {
      if (!drag) return;
      const f = fpv.current;
      f.lookYaw += (e.clientX - drag.x) * 0.004;
      f.lookPitch = Math.max(-1.3, Math.min(1.0, f.lookPitch - (e.clientY - drag.y) * 0.004));
      drag = { x: e.clientX, y: e.clientY };
    };
    const up = () => {
      drag = null;
    };
    const reset = () => {
      fpv.current.lookYaw = 0;
      fpv.current.lookPitch = 0;
    };
    el.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    el.addEventListener('dblclick', reset);
    return () => {
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      el.removeEventListener('dblclick', reset);
    };
  }, [viewMode, gl]);

  // 미니맵 클릭 → 그 지점으로 이동 (카메라와 목표점의 상대 위치는 유지)
  useEffect(() => {
    const c = controls.current;
    if (!c || !focusRequest || useViewStore.getState().viewMode === 'FPV') return;
    const target = new THREE.Vector3(...enuToThree(focusRequest.x, focusRequest.y, 0));
    const offset = camera.position.clone().sub(c.target);
    if (focusRequest.from) {
      // ENU 방향 (x=동, y=북) → Three (x, ·, -y)
      offset.set(focusRequest.from.x, 0.6, -focusRequest.from.y);
    }
    if (focusRequest.dist) {
      // 방향은 유지하고 거리만 줄인다 (너무 눕지 않게 높이는 거리의 절반 이상)
      offset.setLength(focusRequest.dist);
      offset.y = Math.max(offset.y, focusRequest.dist * 0.5);
      offset.setLength(focusRequest.dist);
    }
    anim.current = { position: target.clone().add(offset), target };
  }, [focusRequest, camera]);

  useFrame((_, delta) => {
    const c = controls.current;
    if (!c) return;
    const view = useViewStore.getState();

    if (view.viewMode === 'FPV') {
      const d = engine.getSnapshot().drones.find((x) => x.id === view.fpvDroneId);
      if (d) {
        const p = droneDisplayPos(d, tmp.p);
        const f = fpv.current;
        // 방위는 부드럽게 따라간다 (각도 차이를 -π~π 로 접어서)
        if (!f.init) {
          f.yaw = d.headingRad;
          f.init = true;
        }
        let diff = d.headingRad - f.yaw;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        f.yaw += diff * (1 - Math.exp(-delta * 4));
        const yaw = f.yaw + f.lookYaw;
        const pitch = FPV_PITCH + f.lookPitch;
        // ENU 방위(북=0, 시계) → Three 방향: (sin, ·, -cos)
        const fx = Math.sin(f.yaw);
        const fz = -Math.cos(f.yaw);
        camera.position.set(p.x + fx * FPV_FORWARD, p.z + FPV_UP, -p.y + fz * FPV_FORWARD);
        tmp.look.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
        camera.lookAt(camera.position.x + tmp.look.x, camera.position.y + tmp.look.y, camera.position.z + tmp.look.z);
      }
    } else {
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
      if ((followDroneId || view.followRunnerId) && !anim.current) {
        let p: { x: number; y: number; z: number } | null = null;
        if (view.followRunnerId) {
          const r = engine.getSnapshot().runners.find((x) => x.id === view.followRunnerId);
          if (r) p = runnerDisplayPos(r).pos;
        } else {
          const d = engine.getSnapshot().drones.find((x) => x.id === followDroneId);
          if (d) p = droneDisplayPos(d, tmp.p);
        }
        if (p) {
          const k = 1 - Math.exp(-delta * 8);
          tmp.v.set(p.x, p.z, -p.y).sub(c.target).multiplyScalar(k);
          c.target.add(tmp.v);
          camera.position.add(tmp.v);
          c.update();
        }
      }
    }

    reportAcc.current += delta;
    if (reportAcc.current >= REPORT_INTERVAL_SEC) {
      reportAcc.current = 0;
      const p = threeToEnu(camera.position.x, camera.position.y, camera.position.z);
      let t: { x: number; y: number };
      if (view.viewMode === 'FPV') {
        tmp.look.set(0, 0, -1).applyQuaternion(camera.quaternion);
        t = { x: p.x + tmp.look.x * 80, y: p.y - tmp.look.z * 80 };
      } else t = threeToEnu(c.target.x, c.target.y, c.target.z);
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
