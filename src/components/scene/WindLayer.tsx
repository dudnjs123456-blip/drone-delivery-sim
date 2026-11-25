'use client';

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { defaultConfig } from '@/sim/config';
import { defaultMap } from '@/sim/map/defaultMap';
import { meanWindAt } from '@/sim/wind/weather';
import { engine, runner, useSimStore } from '@/store/simStore';
import { useViewStore } from '@/store/viewStore';
import { palette } from './palette';

const cfg = defaultConfig;
const B = defaultMap.bounds;
const GRID = 50;
const SLOW = new THREE.Color('#22c55e');
const MID = new THREE.Color('#eab308');
const FAST = new THREE.Color('#ef4444');

/** 풍속 → 색 (초록 < 5 < 노랑 < 10 < 빨강 m/s) */
function speedColor(v: number, out: THREE.Color) {
  if (v < 5) return out.copy(SLOW).lerp(MID, v / 5);
  return out.copy(MID).lerp(FAST, Math.min(1, (v - 5) / 5));
}

/** 바람 화살표 격자: 지정 고도의 평균 바람(빌딩풍 포함) × 지금 돌풍 */
function Arrows({ alt }: { alt: number }) {
  const shaft = useRef<THREE.InstancedMesh>(null);
  const head = useRef<THREE.InstancedMesh>(null);
  const pts = useMemo(() => {
    const out: { x: number; y: number }[] = [];
    for (let x = B.minX + GRID / 2; x < B.maxX; x += GRID) for (let y = B.minY + GRID / 2; y < B.maxY; y += GRID) out.push({ x, y });
    return out;
  }, []);
  const tmp = useMemo(() => ({ m: new THREE.Matrix4(), q: new THREE.Quaternion(), c: new THREE.Color(), up: new THREE.Vector3(0, 1, 0), dir: new THREE.Vector3(), s: new THREE.Vector3(), p: new THREE.Vector3() }), []);
  const acc = useRef(1);
  useFrame((_, delta) => {
    acc.current += delta;
    if (acc.current < 0.1 || !shaft.current || !head.current) return;
    acc.current = 0;
    const w = engine.getSnapshot().weather;
    const gustK = w.mean10 > 0.05 ? w.gust10 / w.mean10 : 1;
    pts.forEach((pt, i) => {
      const v = meanWindAt({ x: pt.x, y: pt.y, z: alt }, w.state, w.wakeZones, cfg);
      const sp = Math.hypot(v.x, v.y) * gustK;
      const len = Math.min(40, 4 + sp * 3);
      if (sp < 0.2) {
        tmp.m.makeScale(0, 0, 0);
        shaft.current!.setMatrixAt(i, tmp.m);
        head.current!.setMatrixAt(i, tmp.m);
        return;
      }
      tmp.dir.set(v.x, 0, -v.y).normalize();
      tmp.q.setFromUnitVectors(tmp.up, tmp.dir);
      tmp.p.set(pt.x, alt, -pt.y);
      tmp.s.set(1, len, 1);
      tmp.m.compose(tmp.p.clone().addScaledVector(tmp.dir, len / 2 - len * 0.5), tmp.q, tmp.s);
      shaft.current!.setMatrixAt(i, tmp.m);
      tmp.s.set(1, 1, 1);
      tmp.m.compose(tmp.p.clone().addScaledVector(tmp.dir, len / 2 + 2), tmp.q, tmp.s);
      head.current!.setMatrixAt(i, tmp.m);
      speedColor(sp, tmp.c);
      shaft.current!.setColorAt(i, tmp.c);
      head.current!.setColorAt(i, tmp.c);
    });
    shaft.current.instanceMatrix.needsUpdate = true;
    head.current.instanceMatrix.needsUpdate = true;
    if (shaft.current.instanceColor) shaft.current.instanceColor.needsUpdate = true;
    if (head.current.instanceColor) head.current.instanceColor.needsUpdate = true;
  });
  return (
    <>
      <instancedMesh ref={shaft} args={[undefined, undefined, pts.length]} frustumCulled={false}>
        {/* 길이 1 짜리 막대를 y 로 늘린다 (원점이 막대 아래 끝) */}
        <cylinderGeometry args={[0.9, 0.9, 1, 6]} />
        <meshBasicMaterial transparent opacity={0.45} depthWrite={false} />
      </instancedMesh>
      <instancedMesh ref={head} args={[undefined, undefined, pts.length]} frustumCulled={false}>
        <coneGeometry args={[2.6, 5, 8]} />
        <meshBasicMaterial transparent opacity={0.6} depthWrite={false} />
      </instancedMesh>
    </>
  );
}

/** 바람에 실려 가는 입자 (꼬리가 있는 짧은 선) */
const N_PARTICLES = 700;
function spawnParticle(p: Float32Array, life: Float32Array, i: number) {
  p[i * 3] = B.minX + Math.random() * (B.maxX - B.minX);
  p[i * 3 + 1] = B.minY + Math.random() * (B.maxY - B.minY);
  p[i * 3 + 2] = 8 + Math.random() * 110;
  life[i] = 3 + Math.random() * 6;
}
function Particles() {
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N_PARTICLES * 6), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(N_PARTICLES * 6), 3));
    return g;
  }, []);
  // 입자 상태는 첫 프레임에 만든다 (렌더 중 무작위 값을 만들지 않도록)
  const state = useRef<{ p: Float32Array; life: Float32Array; c: THREE.Color } | null>(null);
  useEffect(() => () => geo.dispose(), [geo]);
  // 버퍼는 3D 객체 참조로 고친다 (렌더 값이 아니라 장면 객체이므로)
  const lines = useRef<THREE.LineSegments>(null);
  useFrame((_, delta) => {
    if (!lines.current) return;
    const g = lines.current.geometry;
    const w = engine.getSnapshot().weather;
    const pos = g.attributes.position.array as Float32Array;
    const col = g.attributes.color.array as Float32Array;
    const gustK = w.mean10 > 0.05 ? w.gust10 / w.mean10 : 1;
    // 입자는 시뮬레이션 배속만큼 빨리 흐른다
    const dt = Math.min(delta, 0.1) * (runner.paused ? 0 : runner.speed);
    if (!state.current) {
      const init = { p: new Float32Array(N_PARTICLES * 3), life: new Float32Array(N_PARTICLES), c: new THREE.Color() };
      for (let i = 0; i < N_PARTICLES; i++) spawnParticle(init.p, init.life, i);
      state.current = init;
    }
    const { p, life, c } = state.current;
    const spawn = (i: number) => spawnParticle(p, life, i);
    for (let i = 0; i < N_PARTICLES; i++) {
      const x = p[i * 3];
      const y = p[i * 3 + 1];
      const z = p[i * 3 + 2];
      const v = meanWindAt({ x, y, z }, w.state, w.wakeZones, cfg);
      const vx = v.x * gustK;
      const vy = v.y * gustK;
      p[i * 3] = x + vx * dt;
      p[i * 3 + 1] = y + vy * dt;
      life[i] -= dt;
      if (life[i] <= 0 || p[i * 3] < B.minX || p[i * 3] > B.maxX || p[i * 3 + 1] < B.minY || p[i * 3 + 1] > B.maxY) spawn(i);
      const tail = 1.2;
      pos[i * 6] = p[i * 3];
      pos[i * 6 + 1] = p[i * 3 + 2];
      pos[i * 6 + 2] = -p[i * 3 + 1];
      pos[i * 6 + 3] = p[i * 3] - vx * tail;
      pos[i * 6 + 4] = p[i * 3 + 2];
      pos[i * 6 + 5] = -(p[i * 3 + 1] - vy * tail);
      speedColor(Math.hypot(vx, vy), c);
      col[i * 6] = col[i * 6 + 3] = c.r;
      col[i * 6 + 1] = col[i * 6 + 4] = c.g;
      col[i * 6 + 2] = col[i * 6 + 5] = c.b;
    }
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
  });
  const meanOk = useSimStore((s) => s.weather.mean10 > 0.3);
  if (!meanOk) return null;
  return (
    <lineSegments ref={lines} geometry={geo} frustumCulled={false}>
      <lineBasicMaterial vertexColors transparent opacity={0.75} />
    </lineSegments>
  );
}

/** 빌딩풍 구역: 높은 건물 뒤 (바람이 빠져나가는 쪽) */
function Wakes() {
  const zones = useSimStore((s) => (s.weather.mean10 > 1 ? s.weather.wakeZones : null));
  const shapes = useMemo(
    () =>
      (zones ?? []).map((z) => {
        const shape = new THREE.Shape(z.polygon.map(([x, y]) => new THREE.Vector2(x, y)));
        return { id: z.buildingId, geo: new THREE.ExtrudeGeometry(shape, { depth: z.heightM * 1.1, bevelEnabled: false }) };
      }),
    [zones],
  );
  useEffect(() => () => shapes.forEach((s) => s.geo.dispose()), [shapes]);
  return (
    <>
      {shapes.map((s) => (
        <mesh key={s.id} geometry={s.geo} rotation={[-Math.PI / 2, 0, 0]}>
          <meshBasicMaterial color="#f97316" transparent opacity={0.09} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      ))}
    </>
  );
}

/** 비: 카메라 주변에 떨어지는 빗줄기 (강수량에 비례) */
const N_RAIN = 2500;
function Rain() {
  const rain = useSimStore((s) => s.weather.state.rainMmH);
  const camera = useThree((s) => s.camera);
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N_RAIN * 6), 3));
    return g;
  }, []);
  const dropsRef = useRef<Float32Array | null>(null);
  useEffect(() => () => geo.dispose(), [geo]);
  const lines = useRef<THREE.LineSegments>(null);
  useFrame((_, delta) => {
    if (rain <= 0 || !lines.current) return;
    const g = lines.current.geometry;
    dropsRef.current ??= new Float32Array(N_RAIN * 3).map((_, i) => (i % 3 === 1 ? Math.random() * 120 : (Math.random() - 0.5) * 400));
    const drops = dropsRef.current;
    const n = Math.min(N_RAIN, Math.round(rain * 120));
    g.setDrawRange(0, n * 2);
    const pos = g.attributes.position.array as Float32Array;
    const w = engine.getSnapshot().weather;
    const to = ((w.state.windFromDeg + 180) * Math.PI) / 180;
    const wx = Math.sin(to) * w.mean10 * 0.3;
    const wz = -Math.cos(to) * w.mean10 * 0.3;
    const cx = camera.position.x;
    const cz = camera.position.z;
    for (let i = 0; i < n; i++) {
      drops[i * 3 + 1] -= 40 * Math.min(delta, 0.1);
      if (drops[i * 3 + 1] < 0) {
        drops[i * 3] = (Math.random() - 0.5) * 400;
        drops[i * 3 + 1] = 120;
        drops[i * 3 + 2] = (Math.random() - 0.5) * 400;
      }
      const x = cx + drops[i * 3];
      const y = drops[i * 3 + 1];
      const z = cz + drops[i * 3 + 2];
      pos.set([x, y, z, x - wx, y + 3, z - wz], i * 6);
    }
    g.attributes.position.needsUpdate = true;
  });
  if (rain <= 0) return null;
  return (
    <lineSegments ref={lines} geometry={geo} frustumCulled={false}>
      <lineBasicMaterial color="#93c5fd" transparent opacity={0.55} />
    </lineSegments>
  );
}

/** 시정에 따라 안개 거리를 바꾼다 */
function WeatherFog() {
  const vis = useSimStore((s) => s.weather.state.visibilityM);
  const rain = useSimStore((s) => s.weather.state.rainMmH);
  const far = Math.min(3000, Math.max(200, vis * 1.3));
  const color = rain > 0 || vis < 2000 ? '#b6c2cc' : palette.sky;
  return (
    <>
      <color attach="background" args={[color]} />
      <fog attach="fog" args={[color, far * 0.25, far]} />
    </>
  );
}

export function WindLayer() {
  const show = useViewStore((s) => s.showWind);
  const alt = useViewStore((s) => s.windAlt);
  const windy = useSimStore((s) => s.weather.mean10 > 0.05);
  return (
    <>
      <WeatherFog />
      <Rain />
      {show && windy && (
        <>
          <Arrows alt={alt} />
          <Particles />
          <Wakes />
        </>
      )}
    </>
  );
}
