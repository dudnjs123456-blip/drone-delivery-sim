/**
 * 시뮬레이션의 모든 수치는 이 파일 한 곳에서 관리한다.
 * 단위: 미터(m), 초(s). km/h 는 표시·입력용이며 내부 계산 전에 m/s 로 변환한다.
 */

export interface SimConfig {
  time: {
    /** 고정 타임스텝 (s) */
    fixedDtSec: number;
    /** 선택 가능한 배속 */
    speedOptions: readonly number[];
    /** 한 렌더 프레임에서 처리할 최대 스텝 수 (느린 기기에서 폭주 방지) */
    maxStepsPerFrame: number;
  };
  drone: {
    cruiseSpeedKmh: number;
    maxAccelMs2: number;
    climbRateMs: number;
    descentRateMs: number;
    maxPayloadKg: number;
    /** 무풍 기준 비행 가능 시간 (s) */
    enduranceSec: number;
    /** 풍속 1 m/s 당 배터리 소모율 증가 비율 (0.04 → 10 m/s 에서 1.4배) */
    batteryWindFactorPerMs: number;
    /** 스테이션 착륙 후 하역에 걸리는 시간 (s) */
    stationDwellSec: number;
    /** 중간 웨이포인트를 통과한 것으로 보는 반경 (m) */
    waypointAcceptM: number;
    /** 감속 계획에 쓰는 가속도 비율 (최대 가속도 대비). 1 미만이어야 추종 여유가 생긴다 */
    brakeAccelRatio: number;
    /** 급회전 웨이포인트에서 허용하는 최저 속도 비율 */
    minCornerSpeedRatio: number;
  };
  altitude: {
    cruiseM: number;
    /** 한국 기본 비행 고도 제한 */
    maxM: number;
  };
  wind: {
    /** 평균 풍속이 이 값 이상이면 운항 중단 (m/s) */
    suspendMeanMs: number;
    /** 돌풍이 이 값 이상이면 운항 중단 (m/s) */
    suspendGustMs: number;
  };
  traffic: {
    /** 드론 간 최소 이격 거리 (m) */
    minSeparationM: number;
  };
  pathfinding: {
    /** 격자 수평 크기 (m) */
    cellSizeM: number;
    /** 격자 고도층 간격 (m). 순항 고도가 층 위에 오도록 맞춘다 */
    layerHeightM: number;
    /** 경로 탐색에 쓰는 최저 고도 (m) */
    minAltitudeM: number;
    /** 건물 옆면과의 최소 수평 거리 (m) */
    buildingClearanceM: number;
    /** 건물 옥상 위 최소 수직 거리 (m) */
    verticalClearanceM: number;
    /** 비행금지구역 경계 바깥 여유 (m) */
    noFlyMarginM: number;
    /** 직선 가시성 검사 샘플 간격 (m) */
    losSampleM: number;
  };
  fleet: {
    /** 운용 드론 수. 도크에 순서대로 나눠 배치한다 */
    droneCount: number;
    /** 시험 비행(FLY_MISSION) 기본 탑재 중량 (kg) */
    missionPayloadKg: number;
  };
}

export const defaultConfig: SimConfig = {
  time: {
    fixedDtSec: 0.05,
    speedOptions: [1, 5, 20],
    maxStepsPerFrame: 2000,
  },
  drone: {
    cruiseSpeedKmh: 40,
    maxAccelMs2: 2,
    climbRateMs: 3,
    descentRateMs: 3,
    maxPayloadKg: 3,
    enduranceSec: 20 * 60,
    batteryWindFactorPerMs: 0.04,
    stationDwellSec: 30,
    waypointAcceptM: 3,
    brakeAccelRatio: 0.8,
    minCornerSpeedRatio: 0.2,
  },
  altitude: {
    cruiseM: 60,
    maxM: 150,
  },
  wind: {
    suspendMeanMs: 10,
    suspendGustMs: 15,
  },
  traffic: {
    minSeparationM: 15,
  },
  pathfinding: {
    cellSizeM: 5,
    layerHeightM: 10,
    minAltitudeM: 30,
    buildingClearanceM: 10,
    verticalClearanceM: 10,
    noFlyMarginM: 5,
    losSampleM: 1,
  },
  fleet: {
    droneCount: 1,
    missionPayloadKg: 1.5,
  },
};
