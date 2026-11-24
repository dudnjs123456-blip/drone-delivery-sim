/**
 * 돌발 상황 종류별 설명과 대응 정책 안내 (패널에 그대로 보여 준다).
 * 각 정책의 장단점은 시뮬레이션 테스트 결과(src/sim/hazards/hazards.test.ts)와 맞춰 적었다.
 */
import type { HazardKind, ResponsePolicies } from '@/sim/hazards/types';

export interface PolicyOption<K extends HazardKind> {
  value: ResponsePolicies[K];
  label: string;
  desc: string;
}

export interface HazardInfo<K extends HazardKind = HazardKind> {
  kind: K;
  icon: string;
  title: string;
  /** 무엇을 흉내 내는가 */
  what: string;
  /** 드론·관제가 언제 알게 되는가 */
  detection: string;
  options: PolicyOption<K>[];
  /** 실제 운용에서 함께 쓰는 대응 (시뮬레이션 밖) */
  realWorld: string;
}

export const HAZARD_CATALOG: { [K in HazardKind]: HazardInfo<K> } = {
  TFR: {
    kind: 'TFR',
    icon: '⛔',
    title: '임시 비행금지구역',
    what: '화재 진압 헬기, 행사·집회, 요인 경호 등으로 갑자기 생기는 원기둥 공역 제한',
    detection: 'UTM(드론 교통관리)이 발령 즉시 방송 → 통신이 살아 있는 드론은 바로 안다',
    options: [
      { value: 'REROUTE', label: '재경로', desc: '현재 위치에서 A* 로 다시 계획해 우회. 배송은 이어 가지만 거리·시간이 늘어난다' },
      { value: 'RTH', label: '즉시 복귀', desc: '도크로 돌아가고 주문은 다른 드론에 재배정. 가장 보수적, 배송 지연이 크다' },
      { value: 'IGNORE', label: '무시 (비교용)', desc: '경로 유지 → 침범 건수로 위험을 확인' },
    ],
    realWorld: '사전 NOTAM 구독, 비행 전 공역 재확인, 지오펜스 강제 적용',
  },
  OBSTACLE: {
    kind: 'OBSTACLE',
    icon: '🏗️',
    title: '미등록 장애물',
    what: '지도에 없는 타워크레인·공사 가설물·임시 구조물',
    detection: '기체 센서(라이다·카메라) 탐지 거리 안에 들어와야 안다. 처음 발견한 드론이 UTM 에 공유하면 나머지도 피한다',
    options: [
      { value: 'REROUTE', label: '탐지 즉시 재경로', desc: '발견 지점에서 바로 우회. 센서 거리가 정지 거리(약 31m)+안전 여유보다 짧으면 늦는다' },
      { value: 'HOLD_RTH', label: '정지 후 복귀', desc: '10초 제자리 정지 후 도크로 복귀. 미지의 공역에 더 들어가지 않는다' },
      { value: 'IGNORE', label: '무시 (비교용)', desc: '경로 유지 → 충돌·추락' },
    ],
    realWorld: '건설 현장 신고 의무화와 지도 갱신, 크레인 위치 데이터 연동, 센서 이중화',
  },
  INTRUDER: {
    kind: 'INTRUDER',
    icon: '🚁',
    title: '비협조 비행체',
    what: '응급 헬기·미등록 드론처럼 우리 예약 체계에 없는 비행체',
    detection: 'ADS-B 송신기가 있으면 UTM 경보(기본 250m), 없으면 기체 센서(기본 60m)로만 안다',
    options: [
      { value: 'VERTICAL', label: '고도 회피', desc: '정지하며 위·아래로 30m 비켜 선다. 상승률 3m/s 라서 미리 알아야(ADS-B) 효과가 있다' },
      { value: 'HOLD', label: '제자리 정지', desc: '그 자리에 멈춘다. 상대가 정면으로 오면 피하지 못한다' },
      { value: 'IGNORE', label: '무시 (비교용)', desc: '경로 유지 → 근접(NMAC)·충돌 확인' },
    ],
    realWorld: '유인기 우선 원칙, 저고도 회랑 분리, Remote ID·ADS-B In 수신, 탐지·회피(DAA) 센서',
  },
  BATTERY_DROP: {
    kind: 'BATTERY_DROP',
    icon: '🔋',
    title: '배터리 급감',
    what: '셀 불량, 저온, 과부하로 잔량이 갑자기 떨어짐',
    detection: '기체가 스스로 안다 (통신과 무관)',
    options: [
      { value: 'NEAREST', label: '가장 가까운 패드 비상착륙', desc: '도크·스테이션 중 가장 가까운 곳에 내린다. 추락은 피하지만 회수가 필요하고 화물은 실패 처리' },
      { value: 'RTH', label: '도크 복귀', desc: '집으로 돌아간다. 거리가 멀면 도중에 방전될 수 있다' },
      { value: 'IGNORE', label: '무시 (비교용)', desc: '비행 계속 → 방전 시 추락' },
    ],
    realWorld: '출발 전 잔량 기준 상향, 셀 온도·전압 모니터링, 경로상 비상착륙지 확보',
  },
  LINK_LOSS: {
    kind: 'LINK_LOSS',
    icon: '📡',
    title: '통신 두절',
    what: 'LTE·무선 링크 끊김 (음영 지역, 간섭)',
    detection: '기체가 스스로 안다. 두절 중에는 UTM 의 비행금지·폐쇄·침입기 경보를 받을 수 없다',
    options: [
      { value: 'HOLD_RTH', label: '대기 후 복귀', desc: '30초 제자리 대기, 그 안에 복구되면 이어 가고 아니면 복귀' },
      { value: 'RTH', label: '즉시 복귀', desc: '바로 도크로. 짧은 끊김에도 배송이 취소된다' },
      { value: 'CONTINUE', label: '자율 비행 계속', desc: '계획 경로대로 계속. 새 비행금지구역·폐쇄를 모른 채 들어갈 수 있다' },
    ],
    realWorld: '통신 이중화(LTE+전용 무선), 음영 지역 사전 측정, 링크 손실 시 동작을 비행 전 등록',
  },
  STATION_CLOSED: {
    kind: 'STATION_CLOSED',
    icon: '🚧',
    title: '스테이션 폐쇄',
    what: '패드 고장, 사람·차량 진입, 정전 등으로 착륙 불가',
    detection: 'UTM 이 방송 (통신두절 드론은 모르고 내려올 수 있다)',
    options: [
      { value: 'DIVERT', label: '다른 스테이션 전환', desc: '가장 가까운 열린 스테이션으로. 배송은 되지만 문 앞까지 더 멀다' },
      { value: 'HOLD', label: '상공 대기', desc: '다시 열릴 때까지 공중에서 기다린다. 배터리를 쓰고 공역을 차지한다' },
      { value: 'RTH', label: '복귀', desc: '도크로 돌아가고 주문은 재배정' },
    ],
    realWorld: '스테이션 펜스·센서로 침입 감지, 예비 스테이션 지정, 착륙 직전 최종 확인',
  },
};

export const HAZARD_KINDS = Object.keys(HAZARD_CATALOG) as HazardKind[];
