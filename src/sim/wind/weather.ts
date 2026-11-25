/**
 * 날씨·바람 모델 (순수 함수 + 상태 타입).
 * - 평균 바람: 풍향·풍속(지상 10m 기준) + 고도 증가(멱법칙) + 건물 뒤 빌딩풍 구역
 * - 돌풍: 전체 돌풍 계수(시간 상관 무작위, Ornstein–Uhlenbeck) + 드론마다 작은 난류
 * - 날씨: 강수(배터리·센서), 기온(배터리 용량), 시정(센서)
 * 엔진이 상태를 갖고 시간에 따라 진행시키며, 화면도 같은 함수로 바람을 그린다.
 */
import type { SimConfig } from '../config';
import type { MapData, Vec2Tuple, Vec3 } from '../types';
import { polygonCentroid } from '../util/geometry';

export interface WeatherState {
  /** 바람이 불어오는 방향 (도, 북=0 시계 방향) */
  windFromDeg: number;
  /** 평균 풍속, 지상 10m (m/s) */
  windMeanMs: number;
  /** 돌풍 세기 0~1 (0 = 고른 바람, 1 = 평균의 2배 안팎까지 출렁임) */
  gustiness: number;
  /** 강수 (mm/h) */
  rainMmH: number;
  /** 기온 (°C) */
  tempC: number;
  /** 시정 (m) */
  visibilityM: number;
}

export const CALM: WeatherState = { windFromDeg: 270, windMeanMs: 0, gustiness: 0, rainMmH: 0, tempC: 15, visibilityM: 10000 };

export interface WeatherPreset {
  id: string;
  icon: string;
  label: string;
  desc: string;
  state: WeatherState;
}

export const WEATHER_PRESETS: WeatherPreset[] = [
  { id: 'calm', icon: '☀️', label: '맑음·무풍', desc: '바람 없음', state: CALM },
  { id: 'breeze', icon: '🍃', label: '산들바람', desc: '서풍 4m/s', state: { ...CALM, windFromDeg: 270, windMeanMs: 4, gustiness: 0.2 } },
  { id: 'windy', icon: '💨', label: '바람 강함', desc: '북서풍 7m/s, 돌풍 약간', state: { ...CALM, windFromDeg: 315, windMeanMs: 7, gustiness: 0.35, tempC: 8 } },
  { id: 'gusty', icon: '🌪️', label: '돌풍 주의', desc: '평균 6m/s, 돌풍 15m/s 안팎', state: { ...CALM, windFromDeg: 290, windMeanMs: 6, gustiness: 0.9, tempC: 10 } },
  { id: 'rain', icon: '🌧️', label: '비', desc: '남풍 5m/s, 시간당 8mm', state: { ...CALM, windFromDeg: 180, windMeanMs: 5, gustiness: 0.4, rainMmH: 8, tempC: 12, visibilityM: 2500 } },
  { id: 'cold', icon: '🥶', label: '한파', desc: '북풍 5m/s, 영하 10°C', state: { ...CALM, windFromDeg: 0, windMeanMs: 5, gustiness: 0.3, tempC: -10 } },
  { id: 'fog', icon: '🌫️', label: '짙은 안개', desc: '시정 250m', state: { ...CALM, windFromDeg: 90, windMeanMs: 1.5, gustiness: 0.1, tempC: 6, visibilityM: 250 } },
  { id: 'storm', icon: '⛈️', label: '태풍급', desc: '동풍 13m/s, 폭우', state: { ...CALM, windFromDeg: 100, windMeanMs: 13, gustiness: 0.8, rainMmH: 25, tempC: 20, visibilityM: 800 } },
];

/** 바람이 "불어가는" 방향 단위 벡터 (ENU 수평) */
export function windToDir(fromDeg: number): { x: number; y: number } {
  const r = ((fromDeg + 180) * Math.PI) / 180;
  return { x: Math.sin(r), y: Math.cos(r) };
}

/** 고도 z 에서의 평균 풍속 배율 (기준 높이 대비) */
export function shearFactor(z: number, cfg: SimConfig): number {
  const w = cfg.wind;
  return Math.pow(Math.max(2, z) / w.refHeightM, w.shearExponent);
}

export interface WakeZone {
  buildingId: string;
  /** 건물 뒤 직사각형 (반시계) */
  polygon: Vec2Tuple[];
  heightM: number;
  /** 구역 판정용 */
  origin: { x: number; y: number };
  startS: number;
  lengthM: number;
  halfWidthM: number;
}

/** 풍향에 따른 빌딩풍 구역: 높은 건물의 바람 받는 반대쪽(뒤)에 건물 높이 × 계수 길이 */
export function wakeZones(map: MapData, fromDeg: number, cfg: SimConfig): WakeZone[] {
  const u = windToDir(fromDeg);
  const n = { x: -u.y, y: u.x };
  const out: WakeZone[] = [];
  for (const b of map.buildings) {
    if (b.heightM < cfg.wind.wakeMinHeightM) continue;
    const [cx, cy] = polygonCentroid(b.footprint);
    let maxS = -Infinity;
    let maxN = 0;
    for (const [x, y] of b.footprint) {
      const dx = x - cx;
      const dy = y - cy;
      maxS = Math.max(maxS, dx * u.x + dy * u.y);
      maxN = Math.max(maxN, Math.abs(dx * n.x + dy * n.y));
    }
    const L = b.heightM * cfg.wind.wakeLengthFactor;
    const w = maxN + 4;
    const p = (s: number, t: number): Vec2Tuple => [cx + u.x * s + n.x * t, cy + u.y * s + n.y * t];
    out.push({
      buildingId: b.id,
      polygon: [p(maxS, -w), p(maxS + L, -w), p(maxS + L, w), p(maxS, w)],
      heightM: b.heightM,
      origin: { x: cx, y: cy },
      startS: maxS,
      lengthM: L,
      halfWidthM: w,
    });
  }
  return out;
}

/** 빌딩풍 배율: 구역 시작(건물 바로 뒤)에서 가장 세고 끝으로 갈수록 약해진다 */
export function wakeFactor(p: Vec3, zones: readonly WakeZone[], fromDeg: number, cfg: SimConfig): { speed: number; gust: number } {
  const u = windToDir(fromDeg);
  const n = { x: -u.y, y: u.x };
  let best = 0;
  for (const z of zones) {
    if (p.z > z.heightM * 1.1) continue;
    const dx = p.x - z.origin.x;
    const dy = p.y - z.origin.y;
    const s = dx * u.x + dy * u.y - z.startS;
    const t = Math.abs(dx * n.x + dy * n.y);
    if (s < 0 || s > z.lengthM || t > z.halfWidthM) continue;
    const k = 1 - s / z.lengthM;
    best = Math.max(best, k);
  }
  return { speed: 1 + (cfg.wind.wakeAmplify - 1) * best, gust: 1 + (cfg.wind.wakeGustAmplify - 1) * best };
}

/** 위치 p 의 평균 바람 벡터 (m/s). 돌풍 제외 — 경로 예측에 쓴다 */
export function meanWindAt(p: Vec3, w: WeatherState, zones: readonly WakeZone[], cfg: SimConfig): Vec3 {
  if (w.windMeanMs <= 0) return { x: 0, y: 0, z: 0 };
  const u = windToDir(w.windFromDeg);
  const sp = w.windMeanMs * shearFactor(p.z, cfg) * wakeFactor(p, zones, w.windFromDeg, cfg).speed;
  return { x: u.x * sp, y: u.y * sp, z: 0 };
}

/** 운항 가능 여부 (지상 10m 기준 평균·돌풍) */
export function flightStatus(meanMs: number, gustMs: number, cfg: SimConfig): { level: 'OK' | 'CAUTION' | 'SUSPENDED'; reason: string | null } {
  const w = cfg.wind;
  if (meanMs >= w.suspendMeanMs) return { level: 'SUSPENDED', reason: `평균 풍속 ${meanMs.toFixed(1)}m/s ≥ ${w.suspendMeanMs}` };
  if (gustMs >= w.suspendGustMs) return { level: 'SUSPENDED', reason: `돌풍 ${gustMs.toFixed(1)}m/s ≥ ${w.suspendGustMs}` };
  if (meanMs >= w.suspendMeanMs * w.cautionRatio || gustMs >= w.suspendGustMs * w.cautionRatio) return { level: 'CAUTION', reason: '기준에 가까움' };
  return { level: 'OK', reason: null };
}

/** 날씨에 따른 배터리 소모율 배율 (1 = 무풍·맑음·15°C) */
export function batteryRateFactor(localWindMs: number, w: WeatherState, cfg: SimConfig): number {
  const wind = 1 + cfg.drone.batteryWindFactorPerMs * localWindMs;
  const rain = 1 + cfg.weather.batteryRainPerMmH * w.rainMmH;
  return (wind * rain) / batteryCapacityFactor(w, cfg);
}

/** 저온에서 쓸 수 있는 배터리 용량 비율 */
export function batteryCapacityFactor(w: WeatherState, cfg: SimConfig): number {
  const cold = Math.max(0, cfg.weather.batteryRefTempC - w.tempC);
  return Math.max(0.5, 1 - cfg.weather.batteryColdPerDegC * cold);
}

/** 강수·시정에 따른 센서 거리 배율 */
export function sensorFactor(w: WeatherState, cfg: SimConfig): number {
  const vis = Math.min(1, Math.max(0.15, w.visibilityM / cfg.weather.sensorFullVisibilityM));
  return vis / (1 + cfg.weather.sensorRainPerMmH * w.rainMmH);
}

export interface WeatherStats {
  /** 실제 배터리 소모 / 무풍·맑음이었을 때 소모 (누적, 비행 중 드론) */
  energyUsed: number;
  energyCalm: number;
  /** 맞바람으로 늦어진 시간 (누적, s) */
  windDelaySec: number;
  maxCrossTrackM: number;
  /** 운항 중단 횟수와 누적 시간 */
  suspensions: number;
  suspendedSec: number;
  /** 날씨로 라이더에게 넘긴 주문 */
  riderOrders: number;
}

export interface WeatherForecast {
  id: string;
  at: number;
  label: string;
  state: WeatherState;
}

export interface WeatherSnapshot {
  state: WeatherState;
  target: WeatherState;
  auto: boolean;
  /** 지상 10m 평균·현재 돌풍 (m/s) */
  mean10: number;
  gust10: number;
  /** 순항 고도(60m) 평균 풍속 */
  meanCruise: number;
  status: { level: 'OK' | 'CAUTION' | 'SUSPENDED'; reason: string | null };
  sensorFactor: number;
  capacityFactor: number;
  /** 순항 고도 평균 바람에서의 배터리 소모 배율 */
  drainAtCruise: number;
  stats: WeatherStats;
  wakeZones: readonly WakeZone[];
  forecasts: readonly WeatherForecast[];
}

export const emptyWeatherStats = (): WeatherStats => ({
  energyUsed: 0,
  energyCalm: 0,
  windDelaySec: 0,
  maxCrossTrackM: 0,
  suspensions: 0,
  suspendedSec: 0,
  riderOrders: 0,
});

/** 두 날씨 사이를 f(0~1) 만큼 (풍향은 짧은 쪽으로 돈다) */
export function lerpWeather(a: WeatherState, b: WeatherState, f: number): WeatherState {
  let d = ((b.windFromDeg - a.windFromDeg + 540) % 360) - 180;
  if (a.windMeanMs < 0.05) d = b.windFromDeg - a.windFromDeg; // 무풍이면 바로 그 방향으로
  const L = (x: number, y: number) => x + (y - x) * f;
  return {
    windFromDeg: (((a.windFromDeg + d * f) % 360) + 360) % 360,
    windMeanMs: L(a.windMeanMs, b.windMeanMs),
    gustiness: L(a.gustiness, b.gustiness),
    rainMmH: L(a.rainMmH, b.rainMmH),
    tempC: L(a.tempC, b.tempC),
    visibilityM: L(a.visibilityM, b.visibilityM),
  };
}
