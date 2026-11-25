/**
 * 원클릭 돌발 상황 시나리오.
 * 시험 비행을 띄우고 → 순항에 들어가면 → 드론 앞에 돌발 상황을 넣고 → 끝나면 결과를 낸다.
 * 대응 정책은 그때의 설정을 쓰므로, 정책을 바꿔 다시 실행하면 바로 비교할 수 있다.
 */
import { pointAhead } from '@/sim/hazards/geometry';
import type { HazardKind, HazardSpec, SafetyStats } from '@/sim/hazards/types';
import type { Vec3 } from '@/sim/types';

interface DroneLike {
  id: string;
  position: Vec3;
  path: readonly Vec3[];
  pathIndex: number;
  headingRad: number;
}

export interface ScenarioPreset {
  id: string;
  kind: HazardKind;
  icon: string;
  title: string;
  /** 화면에 보일 상황 설명 */
  desc: string;
  fromDockId: string;
  toStationId: string;
  build: (d: DroneLike) => HazardSpec;
}

const DOCK = 'dock-c';
const STATION = 'station-s';

export const SCENARIOS: ScenarioPreset[] = [
  {
    id: 'tfr',
    kind: 'TFR',
    icon: '⛔',
    title: '앞에 비행금지구역 발령',
    desc: '160m 앞에 반경 50m 임시 비행금지구역이 생깁니다 (화재 헬기 출동 가정)',
    fromDockId: DOCK,
    toStationId: STATION,
    build: (d) => ({ kind: 'TFR', center: pointAhead(d, 160), radiusM: 50, durationSec: 240 }),
  },
  {
    id: 'crane',
    kind: 'OBSTACLE',
    icon: '🏗️',
    title: '지도에 없는 크레인',
    desc: '170m 앞에 높이 110m 타워크레인. UTM 은 모르고, 센서 탐지 거리에 들어와야 압니다',
    fromDockId: DOCK,
    toStationId: STATION,
    build: (d) => ({ kind: 'OBSTACLE', center: pointAhead(d, 170), sizeM: 16, heightM: 110 }),
  },
  {
    id: 'heli',
    kind: 'INTRUDER',
    icon: '🚁',
    title: '헬기 정면 접근 (ADS-B 있음)',
    desc: '320m 앞에서 같은 고도로 마주 보고 날아옵니다. ADS-B 경보로 일찍 압니다',
    fromDockId: DOCK,
    toStationId: STATION,
    build: (d) => headOn(d, true),
  },
  {
    id: 'heli-dark',
    kind: 'INTRUDER',
    icon: '🛸',
    title: '미등록 드론 정면 접근 (ADS-B 없음)',
    desc: '같은 상황이지만 송신기가 없어 센서 거리에서야 압니다',
    fromDockId: DOCK,
    toStationId: STATION,
    build: (d) => headOn(d, false),
  },
  {
    id: 'battery',
    kind: 'BATTERY_DROP',
    icon: '🔋',
    title: '배터리 3% 로 급감',
    desc: '셀 불량으로 잔량이 갑자기 3% 가 됩니다 (약 36초 비행 가능)',
    fromDockId: DOCK,
    toStationId: STATION,
    build: (d) => ({ kind: 'BATTERY_DROP', droneId: d.id, toPercent: 3 }),
  },
  {
    id: 'link',
    kind: 'LINK_LOSS',
    icon: '📡',
    title: '통신 40초 두절',
    desc: '음영 지역에서 40초 동안 관제 통신이 끊깁니다',
    fromDockId: DOCK,
    toStationId: STATION,
    build: (d) => ({ kind: 'LINK_LOSS', droneId: d.id, durationSec: 40 }),
  },
  {
    id: 'station',
    kind: 'STATION_CLOSED',
    icon: '🚧',
    title: '목적지 스테이션 폐쇄',
    desc: '가는 도중 남측 스테이션에 사람이 들어가 2분간 착륙 금지',
    fromDockId: DOCK,
    toStationId: STATION,
    build: () => ({ kind: 'STATION_CLOSED', stationId: STATION, durationSec: 120 }),
  },
];

function headOn(d: DroneLike, adsb: boolean): HazardSpec {
  const start = pointAhead(d, 320);
  const hd = (Math.atan2(d.position.x - start.x, d.position.y - start.y) * 180) / Math.PI;
  return { kind: 'INTRUDER', start, headingDeg: (hd + 360) % 360, speedMs: 15, altitudeM: Math.round(d.position.z), adsb, durationSec: 90 };
}

export type ScenarioStage = 'LAUNCHING' | 'CRUISING' | 'INJECTED' | 'DONE';

export interface ScenarioResult {
  safe: boolean;
  delivered: boolean;
  durationSec: number;
  /** 사람이 읽는 결과 줄 */
  lines: { text: string; tone: 'good' | 'bad' | 'warn' | 'info' }[];
}

export interface ScenarioRun {
  presetId: string;
  droneId: string;
  stage: ScenarioStage;
  startedAt: number;
  cruiseSince?: number;
  injectedAt?: number;
  hazardId?: string;
  /** 실행 당시 정책 이름 */
  policyLabel: string;
  before: SafetyStats;
  result?: ScenarioResult;
}

/** 시나리오 전후 안전 지표 차이로 결과를 만든다 */
export function scenarioResult(before: SafetyStats, after: SafetyStats, delivered: boolean, failed: boolean, durationSec: number): ScenarioResult {
  const d = (k: keyof SafetyStats) => after[k] - before[k];
  const lines: ScenarioResult['lines'] = [];
  const bad: [keyof SafetyStats, string][] = [
    ['crashes', '추락'],
    ['nearMisses', '근접(NMAC)'],
    ['tfrIncursions', '비행금지구역 침범'],
    ['closedLandings', '폐쇄 스테이션 착륙'],
  ];
  const acts: [keyof SafetyStats, string][] = [
    ['reroutes', '재경로'],
    ['holds', '공중 대기'],
    ['returns', '도크 복귀'],
    ['emergencyLandings', '비상착륙'],
    ['diverts', '스테이션 전환'],
  ];
  let safe = true;
  for (const [k, l] of bad) {
    if (d(k) > 0) {
      safe = false;
      lines.push({ text: `${l} ${d(k)}회`, tone: 'bad' });
    }
  }
  if (safe) lines.push({ text: '추락·근접·침범 없음', tone: 'good' });
  const done = acts.filter(([k]) => d(k) > 0).map(([k, l]) => `${l} ${d(k)}`);
  lines.push({ text: done.length ? `대응: ${done.join(', ')}` : '대응 동작 없음', tone: done.length ? 'info' : 'warn' });
  lines.push({
    text: failed ? '드론 운용 불가 (추락 또는 비상착륙)' : delivered ? '배송 완료 후 귀환' : '배송하지 못하고 귀환',
    tone: failed ? 'bad' : delivered ? 'good' : 'warn',
  });
  return { safe, delivered, durationSec, lines };
}
