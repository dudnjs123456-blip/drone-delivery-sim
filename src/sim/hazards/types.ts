/**
 * 돌발 상황(장애 변수)과 대응 정책.
 * 사용자가 원하는 시점에 주입하고, 종류별 대응 정책을 바꿔 가며 실용성을 비교한다.
 */
import type { Vec3 } from '../types';

export type HazardKind = 'TFR' | 'OBSTACLE' | 'INTRUDER' | 'BATTERY_DROP' | 'LINK_LOSS' | 'STATION_CLOSED';

export type HazardSpec =
  /** 임시 비행금지구역 (화재·행사·요인 경호 등). UTM 이 즉시 방송한다 */
  | { kind: 'TFR'; center: { x: number; y: number }; radiusM: number; durationSec: number | null }
  /** 지도에 없는 장애물 (타워크레인·공사 가설물). 기체 센서 탐지 거리 안에 들어와야 안다 */
  | { kind: 'OBSTACLE'; center: { x: number; y: number }; sizeM: number; heightM: number }
  /** 비협조 비행체 (헬기·미등록 드론). ADS-B 가 있으면 UTM 으로 공유, 없으면 센서로만 탐지 */
  | {
      kind: 'INTRUDER';
      start: { x: number; y: number };
      headingDeg: number;
      speedMs: number;
      altitudeM: number;
      adsb: boolean;
      durationSec: number;
    }
  /** 배터리 급감 (셀 불량·저온). droneId 가 없으면 비행 중인 드론 중 무작위 */
  | { kind: 'BATTERY_DROP'; droneId: string | null; toPercent: number }
  /** 통신(C2 링크) 두절. 두절 중에는 UTM 지시(재경로·경보)를 받을 수 없다 */
  | { kind: 'LINK_LOSS'; droneId: string | null; durationSec: number }
  /** 스테이션 폐쇄 (패드 고장·사람 진입) */
  | { kind: 'STATION_CLOSED'; stationId: string; durationSec: number };

export interface ResponsePolicies {
  TFR: 'REROUTE' | 'RTH' | 'IGNORE';
  OBSTACLE: 'REROUTE' | 'HOLD_RTH' | 'IGNORE';
  INTRUDER: 'HOLD' | 'VERTICAL' | 'IGNORE';
  BATTERY_DROP: 'RTH' | 'NEAREST' | 'IGNORE';
  LINK_LOSS: 'CONTINUE' | 'HOLD_RTH' | 'RTH';
  STATION_CLOSED: 'DIVERT' | 'HOLD' | 'RTH';
}

export const defaultPolicies: ResponsePolicies = {
  TFR: 'REROUTE',
  OBSTACLE: 'REROUTE',
  INTRUDER: 'VERTICAL',
  BATTERY_DROP: 'NEAREST',
  LINK_LOSS: 'HOLD_RTH',
  STATION_CLOSED: 'DIVERT',
};

export interface HazardSettings {
  /** 기체 센서(라이다·카메라) 탐지 거리 (m) */
  sensorRangeM: number;
  /** ADS-B/UTM 으로 비협조 비행체 경보를 받는 거리 (m) */
  adsbAlertRangeM: number;
  /** 침입기가 이 거리 밖으로 멀어지면 대기를 풀고 재개 (m) */
  intruderClearRangeM: number;
  /** 통신 두절 시 대기 후 복귀 정책의 대기 시간 (s) */
  linkLossHoldSec: number;
}

export type HazardStatus = 'SCHEDULED' | 'ACTIVE' | 'ENDED' | 'CANCELLED';

export interface HazardState {
  id: string;
  spec: HazardSpec;
  /** 발생 (예정) 시각 */
  at: number;
  status: HazardStatus;
  endedAt?: number;
  /** OBSTACLE: 센서로 탐지되어 UTM 에 공유되었는지 */
  discovered?: boolean;
  discoveredBy?: string;
  /** INTRUDER: 현재 위치 */
  position?: Vec3;
  /** BATTERY_DROP·LINK_LOSS: 실제로 적용된 드론 */
  targetDroneId?: string;
}

export type HazardLogSeverity = 'info' | 'warn' | 'bad' | 'good';

export interface HazardLogEntry {
  t: number;
  hazardId?: string;
  droneId?: string;
  severity: HazardLogSeverity;
  text: string;
}

export interface SafetyStats {
  /** 장애물 충돌·배터리 방전·공중 충돌로 인한 추락 */
  crashes: number;
  /** 비협조 비행체와 근접 (NMAC) */
  nearMisses: number;
  /** 임시 비행금지구역 침범 */
  tfrIncursions: number;
  reroutes: number;
  holds: number;
  returns: number;
  emergencyLandings: number;
  diverts: number;
  /** 폐쇄된 스테이션에 착륙 (통신두절 등으로 폐쇄를 모른 경우) */
  closedLandings: number;
  /** 다른 드론으로 다시 배정하려고 대기열로 돌린 주문 */
  ordersRequeued: number;
  ordersFailed: number;
}

export const emptySafety = (): SafetyStats => ({
  crashes: 0,
  nearMisses: 0,
  tfrIncursions: 0,
  reroutes: 0,
  holds: 0,
  returns: 0,
  emergencyLandings: 0,
  diverts: 0,
  closedLandings: 0,
  ordersRequeued: 0,
  ordersFailed: 0,
});
