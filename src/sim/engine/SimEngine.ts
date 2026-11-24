/**
 * 시뮬레이션 엔진 인터페이스.
 * 1차는 자체 단순 물리 엔진(LocalSimEngine)으로 구현하고,
 * 나중에 PX4 SITL + Gazebo 브리지로 교체할 수 있도록 렌더링은 이 인터페이스만 사용한다.
 */
import type { SimConfig } from '../config';
import type { Drone, FlightPhase, MapData, Order, WindState } from '../types';

export type SimCommand =
  /** 시험 비행: 도크에서 스테이션까지 갔다가 복귀 (M2). droneId 가 없으면 대기 중인 첫 드론 */
  | { type: 'FLY_MISSION'; fromDockId: string; toStationId: string; droneId?: string; payloadKg?: number }
  | { type: 'CREATE_ORDER'; storeId?: string; destBuildingId?: string }
  | { type: 'SET_PEAK_MODE'; ordersPerMin: number | null }
  | { type: 'SET_WIND'; fromDirRad: number; meanSpeed: number; gustiness: number }
  /** 시간-공간 예약 테이블 사용 여부 (끄면 충돌 회피 없이 바로 출발 — 비교용) */
  | { type: 'SET_RESERVATIONS'; enabled: boolean };

export type DispatchResult = { ok: true; droneId?: string; orderId?: string } | { ok: false; reason: string };

export interface TrafficStats {
  reservationsEnabled: boolean;
  /** 현재 최소 이격 거리를 어기고 있는 드론 쌍 수 */
  activeViolations: number;
  /** 누적 위반 발생 횟수 (쌍이 새로 가까워질 때마다 1) */
  violationEvents: number;
  /** 예약된 (시간 칸, 셀) 수 */
  reservedCells: number;
  missionsScheduled: number;
  /** 충돌 회피로 늘어난 평균 출발 지연 (s) */
  avgTrafficDelaySec: number;
  /** 기본 순항 고도가 아닌 고도로 배정된 비율 */
  altitudeShiftRatio: number;
  /** 드론 배정을 기다리는 주문 수 */
  queuedOrders: number;
}

export interface PhaseChange {
  t: number;
  droneId: string;
  from: FlightPhase;
  to: FlightPhase;
}

export type SimEvent =
  | ({ type: 'PHASE_CHANGED' } & PhaseChange)
  | { type: 'ORDER_DELIVERED'; orderId: string }
  | { type: 'SEPARATION_VIOLATION'; droneIds: [string, string]; distM: number; t: number }
  | { type: 'FLIGHT_SUSPENDED'; reason: 'MEAN_WIND' | 'GUST' };

/**
 * 엔진 내부 상태를 읽기 전용으로 노출한다 (매 프레임 복사하지 않기 위해 참조를 그대로 돌려준다).
 * 소비자는 값을 수정하면 안 되고, 보관하려면 복사해야 한다.
 */
export interface SimSnapshot {
  time: number;
  drones: readonly Drone[];
  orders: readonly Order[];
  wind: WindState;
  activeAlerts: readonly SimEvent[];
  /** 최근 비행 단계 전환 기록 (오래된 것부터) */
  phaseLog: readonly PhaseChange[];
  traffic: TrafficStats;
  /** 피크 모드 주문 수 (건/분), 꺼져 있으면 null */
  peakOrdersPerMin: number | null;
}

export interface SimEngine {
  load(map: MapData, config: SimConfig, seed: number): void;
  /** 고정 dt 만큼 진행. PX4 엔진이라면 lockstep 으로 구현한다 */
  step(dt: number): void;
  getSnapshot(): SimSnapshot;
  dispatch(cmd: SimCommand): DispatchResult;
  /** 이벤트 구독. 반환값을 호출하면 구독 해제 */
  subscribe(fn: (e: SimEvent) => void): () => void;
  reset(): void;
}
