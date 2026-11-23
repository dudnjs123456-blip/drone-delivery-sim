/**
 * 시뮬레이션 엔진 인터페이스.
 * 1차는 자체 단순 물리 엔진(LocalSimEngine, M2~)으로 구현하고,
 * 나중에 PX4 SITL + Gazebo 브리지로 교체할 수 있도록 렌더링은 이 인터페이스만 사용한다.
 */
import type { SimConfig } from '../config';
import type { Drone, MapData, Order, WindState } from '../types';

export type SimCommand =
  | { type: 'CREATE_ORDER'; storeId?: string; destBuildingId?: string }
  | { type: 'SET_PEAK_MODE'; ordersPerMin: number | null }
  | { type: 'SET_WIND'; fromDirRad: number; meanSpeed: number; gustiness: number };

export type SimEvent =
  | { type: 'ORDER_DELIVERED'; orderId: string }
  | { type: 'SEPARATION_VIOLATION'; droneIds: [string, string]; distM: number }
  | { type: 'FLIGHT_SUSPENDED'; reason: 'MEAN_WIND' | 'GUST' };

export interface SimSnapshot {
  time: number;
  drones: readonly Drone[];
  orders: readonly Order[];
  wind: WindState;
  activeAlerts: readonly SimEvent[];
}

export interface SimEngine {
  load(map: MapData, config: SimConfig, seed: number): void;
  /** 고정 dt 만큼 진행. PX4 엔진이라면 lockstep 으로 구현한다 */
  step(dt: number): void;
  getSnapshot(): SimSnapshot;
  dispatch(cmd: SimCommand): void;
  /** 이벤트 구독. 반환값을 호출하면 구독 해제 */
  subscribe(fn: (e: SimEvent) => void): () => void;
  reset(): void;
}
