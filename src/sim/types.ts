/**
 * 핵심 도메인 타입.
 * 좌표계: ENU (x = 동, y = 북, z = 위), 단위 m. 시각은 시뮬레이션 시작 후 경과 초.
 * 이 파일은 렌더링 라이브러리에 의존하지 않는다.
 */

// ── 공통 ──
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
export type Vec2Tuple = [number, number];

// ── 지도 (src/data/map.json) ──
export interface MapData {
  version: 1;
  name?: string;
  /** ENU 원점의 위경도. 브이월드 등 실제 데이터로 교체할 때 변환 기준점 */
  origin: { lat: number; lon: number };
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  buildings: Building[];
  stores: Store[];
  docks: Dock[];
  stations: Station[];
  noFlyZones: NoFlyZone[];
}

export type BuildingKind = 'APARTMENT' | 'COMMERCIAL';

export interface Building {
  id: string;
  kind: BuildingKind;
  name?: string;
  /** 바닥 다각형 (x, y). 반시계 방향. 로더가 시계 방향 입력을 정규화한다 */
  footprint: Vec2Tuple[];
  /** 지면(z=0)부터 옥상까지 높이 */
  heightM: number;
}

/** 음식이 출발하는 가게 */
export interface Store {
  id: string;
  name?: string;
  buildingId: string;
  position: Vec3;
  /** 음식을 싣는 도크 */
  dockId: string;
  /** 가게 → 도크 도보 이동 시간 (s) */
  walkToDockSec: number;
}

/** 상가 옥상 이륙 도크 */
export interface Dock {
  id: string;
  name?: string;
  buildingId: string;
  /** 도크 중심. z 는 옥상 높이와 같아야 한다 */
  position: Vec3;
  /** 이착륙 패드 수 (옥상 긴 변을 따라 배치) */
  pads: number;
  /** 격납고(대기 드론) 칸 수. 기본 9 */
  parking?: number;
}

/** 단지 내 착륙 스테이션 */
export interface Station {
  id: string;
  name?: string;
  position: Vec3;
  pads: number;
  /** 문 앞까지 배달하는 단지 배송원 수 */
  couriers: number;
  servesBuildingIds: string[];
}

/** 원기둥 형태의 비행금지구역 */
export interface NoFlyZone {
  id: string;
  name?: string;
  center: { x: number; y: number };
  radiusM: number;
  minZ: number;
  maxZ: number;
}

// ── 드론 ──
/**
 * RETURN: 스테이션 이륙부터 도크 착륙까지의 복귀 비행 전체.
 * 내부적으로 상승·순항·하강 로직을 재사용한다.
 */
export type FlightPhase =
  | 'IDLE'
  | 'TAKEOFF'
  | 'CRUISE'
  | 'DESCEND'
  | 'LANDED'
  | 'RETURN'
  /** 돌발 상황 대응으로 공중 대기 (호버링) */
  | 'HOLD'
  /** 추락 또는 비상착륙 — 회수 전까지 운용 불가 */
  | 'FAILED';

export interface Drone {
  id: string;
  phase: FlightPhase;
  position: Vec3;
  /** m/s */
  velocity: Vec3;
  headingRad: number;
  /** 남은 배터리 비율 0~1 */
  battery: number;
  payloadKg: number;
  homeDockId: string;
  orderId: string | null;
  /** 현재 비행의 전체 웨이포인트 (이륙·순항·하강 포함) */
  path: Vec3[];
  pathIndex: number;
  /** 현재 비행의 순항 구간 경로 탐색 정보 */
  route: RouteInfo | null;
  /** 배정되어 출발을 기다리는 경우 예정 출발 시각 */
  departAt: number | null;
  /** 배터리 교체 중이면 끝나는 시각 */
  swapUntil: number | null;
  /** 이번 비행의 순항 고도 (충돌 회피로 바뀔 수 있다) */
  cruiseAltM: number | null;
  /** 돌발 상황 표시 (예: 통신두절, 비상착륙 이동 중, 추락) */
  alert: string | null;
  /** 통신 두절 중이면 복구 시각 */
  linkLostUntil: number | null;
}

export interface RouteInfo {
  /** A* 격자 경로 (평활화 전, 시각화·디버그용) */
  rawPath: Vec3[];
  /** 순항 구간 길이 (m) */
  lengthM: number;
  /** 같은 고도 직선 거리 (m) */
  straightM: number;
  /** 운동 제한만 고려한 최소 순항 시간 (s) */
  estCruiseSec: number;
  expandedNodes: number;
  computeMs: number;
}

// ── 주문 ──
export type OrderStatus =
  | 'COOKING'
  | 'TO_DOCK'
  | 'WAITING_DRONE'
  | 'IN_FLIGHT'
  | 'AT_STATION'
  | 'LAST_MILE'
  | 'DELIVERED'
  /** 바람 기준 초과로 라이더에게 넘어간 주문 */
  | 'RIDER_ASSIGNED'
  /** 추락·비상착륙으로 배송 실패 */
  | 'FAILED';

export type DeliveryMode = 'DRONE' | 'RIDER';

export interface Order {
  id: string;
  storeId: string;
  stationId: string;
  destBuildingId: string;
  weightKg: number;
  mode: DeliveryMode;
  status: OrderStatus;
  droneId: string | null;
  /** 각 시점의 시뮬레이션 시각(s). 구간 시간은 이 값들의 차이로 계산한다 */
  t: {
    created: number;
    /** 드론·예약이 확정된 시각 */
    assigned?: number;
    cookDone?: number;
    atDock?: number;
    takeoff?: number;
    landed?: number;
    courierPickup?: number;
    delivered?: number;
  };
}

// ── 바람 ──
export interface WindState {
  /** 기상 관례: 바람이 "불어오는" 방향 (rad, 북=0, 시계 방향) */
  fromDirRad: number;
  /** 평균 풍속 m/s */
  meanSpeed: number;
  /** 현재 돌풍 풍속 m/s (없으면 0) */
  gustSpeed: number;
}

export interface WindField {
  state(t: number): WindState;
  /** 해당 위치의 바람 벡터 (빌딩풍 증폭 포함), m/s */
  sample(pos: Vec3, t: number): Vec3;
  /** 운항 가능 여부 (평균·돌풍 기준 미만) */
  isFlyable(t: number): boolean;
}
