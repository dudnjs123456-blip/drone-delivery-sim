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
};
