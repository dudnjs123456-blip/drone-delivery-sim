/**
 * 드론 운동 모델: 웨이포인트 폴리라인 추종.
 * - 수평 속도 ≤ 순항 속도, 상승 속도 ≤ climbRate, 하강 속도 ≤ descentRate
 * - |Δv| ≤ maxAccel·dt (3D 가속도 제한)
 * - 경로 끝에서 정지하도록 미리 감속하고, 꺾이는 웨이포인트에서는 각도에 따라 감속한다.
 * 속도 제한 영역(수평 원판 × 수직 구간)은 볼록 집합이므로, 현재 속도와 목표 속도가 모두
 * 제한 안에 있으면 가속도 제한으로 보간한 다음 속도도 항상 제한 안에 있다.
 */
import type { SimConfig } from '../config';
import type { Vec3 } from '../types';
import { kmhToMs } from '../util/units';

export interface KinematicState {
  position: Vec3;
  velocity: Vec3;
}

export interface MotionLimits {
  maxHorizSpeed: number;
  maxClimb: number;
  maxDescent: number;
  maxAccel: number;
  /** 감속 계획용 가속도 (maxAccel 보다 작게) */
  brakeAccel: number;
  minCornerSpeedRatio: number;
  acceptRadius: number;
}

export function limitsFromConfig(cfg: SimConfig): MotionLimits {
  const d = cfg.drone;
  return {
    maxHorizSpeed: kmhToMs(d.cruiseSpeedKmh),
    maxClimb: d.climbRateMs,
    maxDescent: d.descentRateMs,
    maxAccel: d.maxAccelMs2,
    brakeAccel: d.maxAccelMs2 * d.brakeAccelRatio,
    minCornerSpeedRatio: d.minCornerSpeedRatio,
    acceptRadius: d.waypointAcceptM,
  };
}

/** 단위 방향 dir 로 움직일 때 축별 제한을 모두 지키는 최대 속력 */
export function maxSpeedAlong(dir: Vec3, lim: MotionLimits): number {
  const h = Math.hypot(dir.x, dir.y);
  let s = Infinity;
  if (h > 1e-9) s = Math.min(s, lim.maxHorizSpeed / h);
  if (dir.z > 1e-9) s = Math.min(s, lim.maxClimb / dir.z);
  if (dir.z < -1e-9) s = Math.min(s, lim.maxDescent / -dir.z);
  return Number.isFinite(s) ? s : 0;
}

/** 정지 직전 구간의 비례 이득 (1/s). sqrt 감속 곡선이 0 근처에서 발산하지 않게 한다 */
const FINAL_APPROACH_GAIN = 1.2;
/** 이 거리·속력 안으로 들어오면 목표점에 정확히 붙인다 */
const SNAP_DIST = 0.05;
const SNAP_SPEED = 0.15;

export interface FollowResult {
  wpIndex: number;
  done: boolean;
}

/**
 * waypoints[wpIndex] 를 향해 dt 만큼 진행한다. state 를 직접 갱신한다.
 * waypoints[0] 은 출발점, wpIndex 는 1 부터 시작한다.
 */
export function stepAlongPath(
  state: KinematicState,
  waypoints: readonly Vec3[],
  wpIndex: number,
  lim: MotionLimits,
  dt: number,
): FollowResult {
  const n = waypoints.length;
  const p = state.position;
  const v = state.velocity;
  let i = Math.min(Math.max(wpIndex, 1), n - 1);

  // 중간 웨이포인트 통과 처리
  while (i < n - 1 && dist(p, waypoints[i]) < lim.acceptRadius) i++;

  const target = waypoints[i];
  const tx = target.x - p.x;
  const ty = target.y - p.y;
  const tz = target.z - p.z;
  const d = Math.hypot(tx, ty, tz);
  const isLast = i === n - 1;
  const speedNow = Math.hypot(v.x, v.y, v.z);

  if (isLast && d < SNAP_DIST && speedNow < SNAP_SPEED) {
    p.x = target.x;
    p.y = target.y;
    p.z = target.z;
    v.x = v.y = v.z = 0;
    return { wpIndex: i, done: true };
  }

  const dir = d > 1e-9 ? { x: tx / d, y: ty / d, z: tz / d } : { x: 0, y: 0, z: 0 };
  const segLimit = maxSpeedAlong(dir, lim);

  // 경로 끝까지 남은 거리 → 정지 가능한 속력
  let remaining = d;
  for (let k = i; k < n - 1; k++) remaining += dist(waypoints[k], waypoints[k + 1]);
  const vStop = Math.min(Math.sqrt(2 * lim.brakeAccel * remaining), FINAL_APPROACH_GAIN * remaining);

  // 꺾이는 지점 앞 감속
  let vCorner = Infinity;
  if (!isLast) {
    const prev = i > 0 ? waypoints[i - 1] : p;
    const inDir = unit(target.x - prev.x, target.y - prev.y, target.z - prev.z);
    const next = waypoints[i + 1];
    const outDir = unit(next.x - target.x, next.y - target.y, next.z - target.z);
    const cos = inDir.x * outDir.x + inDir.y * outDir.y + inDir.z * outDir.z;
    const cornerSpeed = Math.min(segLimit, maxSpeedAlong(outDir, lim)) * Math.max(lim.minCornerSpeedRatio, (1 + cos) / 2);
    vCorner = Math.sqrt(cornerSpeed * cornerSpeed + 2 * lim.brakeAccel * Math.max(0, d - lim.acceptRadius));
  }

  const speed = Math.min(segLimit, vStop, vCorner);

  // 가속도 제한
  let dvx = dir.x * speed - v.x;
  let dvy = dir.y * speed - v.y;
  let dvz = dir.z * speed - v.z;
  const dv = Math.hypot(dvx, dvy, dvz);
  const maxDv = lim.maxAccel * dt;
  if (dv > maxDv) {
    const k = maxDv / dv;
    dvx *= k;
    dvy *= k;
    dvz *= k;
  }
  v.x += dvx;
  v.y += dvy;
  v.z += dvz;

  p.x += v.x * dt;
  p.y += v.y * dt;
  p.z += v.z * dt;

  return { wpIndex: i, done: false };
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function unit(x: number, y: number, z: number): Vec3 {
  const l = Math.hypot(x, y, z);
  return l > 1e-9 ? { x: x / l, y: y / l, z: z / l } : { x: 0, y: 0, z: 0 };
}
