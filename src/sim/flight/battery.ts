import type { SimConfig } from '../config';

/** 비행 중 배터리 소모. 무풍 기준 enduranceSec 동안 1 → 0, 바람이 셀수록 빨라진다 */
export function drainBattery(battery: number, dt: number, cfg: SimConfig, windSpeedMs: number): number {
  const rate = (1 + cfg.drone.batteryWindFactorPerMs * windSpeedMs) / cfg.drone.enduranceSec;
  return Math.max(0, battery - rate * dt);
}
