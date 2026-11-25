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
  /** 지면 기준 위치 */
  position: Vec3;
  /** 지면 기준 속도 (= 대기 기준 속도 + 바람) */
  velocity: Vec3;
  /** 대기 기준 속도. 바람이 있을 때만 쓴다 (없으면 velocity - 바람 으로 시작) */
  air?: Vec3;
}

export interface MotionLimits {
  /** 계획상 최대 수평 지면 속도 (순항 속도) */
  maxHorizSpeed: number;
  /** 바람을 거스를 때 낼 수 있는 최대 수평 대기 속도 */
  maxAirspeed: number;
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
    maxAirspeed: kmhToMs(d.maxAirspeedKmh ?? d.cruiseSpeedKmh),
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
/** 아주 센 맞바람에서도 이 지면 속도는 내려고 대기 속도를 더 쓴다 (m/s) */
const MIN_GROUND_SPEED = 3;
/** 바람이 있으면 흔들림 때문에 조금 느슨하게 */
const SNAP_DIST_WIND = 1.5;
const SNAP_SPEED_WIND = 2.0;

export interface FollowResult {
  wpIndex: number;
  done: boolean;
}

/**
 * waypoints[wpIndex] 를 향해 dt 만큼 진행한다. state 를 직접 갱신한다.
 * waypoints[0] 은 출발점, wpIndex 는 1 부터 시작한다.
 *
 * wind 가 있으면 기체는 "대기 기준"으로 난다:
 *   원하는 지면 속도 - 바람 = 필요한 대기 속도 → 대기 속도를 제한(최대 수평 속도·가속도)
 *   → 지면 속도 = 대기 속도 + 바람.
 *   맞바람이면 지면 속도가 줄고, 바람이 갑자기 바뀌면(돌풍) 그만큼 밀렸다가 제어기가 되돌린다.
 */
export function stepAlongPath(
  state: KinematicState,
  waypoints: readonly Vec3[],
  wpIndex: number,
  lim: MotionLimits,
  dt: number,
  wind?: Vec3,
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

  const windy = !!wind && (wind.x !== 0 || wind.y !== 0 || wind.z !== 0);
  if (isLast && d < (windy ? SNAP_DIST_WIND : SNAP_DIST) && speedNow < (windy ? SNAP_SPEED_WIND : SNAP_SPEED)) {
    p.x = target.x;
    p.y = target.y;
    p.z = target.z;
    v.x = v.y = v.z = 0;
    state.air = undefined;
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

  if (windy) {
    stepWithWind(state, dir.x * speed, dir.y * speed, dir.z * speed, wind!, lim, dt);
    // 착지: 마지막 지점으로 내려갈 때는 그 높이(패드·옥상) 아래로 내려가지 않는다
    if (isLast && dir.z < 0 && p.z < target.z) {
      p.z = target.z;
      v.z = 0;
      if (state.air) state.air.z = 0;
    }
    return { wpIndex: i, done: false };
  }
  state.air = undefined;

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

/** 바람 속 한 스텝: 대기 속도를 제한·가속도 제한하고, 지면 속도 = 대기 속도 + 바람 */
function stepWithWind(state: KinematicState, gx: number, gy: number, gz: number, wind: Vec3, lim: MotionLimits, dt: number) {
  const p = state.position;
  const v = state.velocity;
  const air = state.air ?? { x: v.x - wind.x, y: v.y - wind.y, z: v.z - wind.z };
  // 원하는 지면 속도를 내려면 필요한 대기 속도 (바람 삼각형).
  // 평소에는 순항 대기 속도로 날아 맞바람이면 지면 속도가 준다.
  // 남는 대기 속도(최대 대기 속도까지)는 ① 옆바람을 이겨 진로를 지키거나
  // ② 맞바람이 너무 세도 최소 지면 속도를 내거나 ③ 제자리에 버티는 데만 쓴다.
  let ax = gx - wind.x;
  let ay = gy - wind.y;
  const gs = Math.hypot(gx, gy);
  let ux = 0;
  let uy = 0;
  let wAlong = 0;
  let cx = wind.x;
  let cy = wind.y;
  if (gs > 1e-6) {
    ux = gx / gs;
    uy = gy / gs;
    wAlong = wind.x * ux + wind.y * uy;
    cx = wind.x - wAlong * ux;
    cy = wind.y - wAlong * uy;
  }
  const cross = Math.hypot(cx, cy);
  const keepMin = Math.hypot(Math.min(gs, MIN_GROUND_SPEED) - wAlong, cross);
  const cap = Math.min(lim.maxAirspeed, Math.max(lim.maxHorizSpeed, keepMin, cross));
  if (Math.hypot(ax, ay) > cap) {
    if (gs > 1e-6) {
      if (cross >= cap) {
        ax = (-cx / cross) * cap;
        ay = (-cy / cross) * cap;
      } else {
        const along = Math.min(gs - wAlong, Math.sqrt(cap * cap - cross * cross));
        ax = along * ux - cx;
        ay = along * uy - cy;
      }
    } else {
      const k = cap / Math.hypot(ax, ay);
      ax *= k;
      ay *= k;
    }
  }
  let az = gz - wind.z;
  az = Math.min(lim.maxClimb, Math.max(-lim.maxDescent, az));
  let dx = ax - air.x;
  let dy = ay - air.y;
  let dz = az - air.z;
  const dv = Math.hypot(dx, dy, dz);
  const maxDv = lim.maxAccel * dt;
  if (dv > maxDv) {
    const k = maxDv / dv;
    dx *= k;
    dy *= k;
    dz *= k;
  }
  air.x += dx;
  air.y += dy;
  air.z += dz;
  state.air = air;
  v.x = air.x + wind.x;
  v.y = air.y + wind.y;
  v.z = air.z + wind.z;
  p.x += v.x * dt;
  p.y += v.y * dt;
  p.z += v.z * dt;
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function unit(x: number, y: number, z: number): Vec3 {
  const l = Math.hypot(x, y, z);
  return l > 1e-9 ? { x: x / l, y: y / l, z: z / l } : { x: 0, y: 0, z: 0 };
}
