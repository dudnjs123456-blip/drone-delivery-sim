/**
 * 임무 실행 단계 함수. 엔진(실제 비행)과 예약 시 궤적 예측이 "같은 함수"를 써서,
 * 바람이 없으면 예측과 실제가 정확히 일치한다.
 *
 * 스텝 규칙
 * - SCHEDULED: step >= departStep 이 되는 스텝에 출발하고, 같은 스텝에 한 번 진행한다.
 * - 구간(leg)이 끝난 스텝에서는 다음 구간을 시작만 하고 진행은 다음 스텝부터.
 * - DWELL: step >= dwellUntilStep 인 스텝에 복귀를 시작하고 같은 스텝에 한 번 진행한다.
 */
import { type KinematicState, type MotionLimits, stepAlongPath } from './kinematics';
import type { Vec3 } from '../types';
import type { Leg } from './route';

export type MissionStage = 'SCHEDULED' | 'OUTBOUND' | 'DWELL' | 'RETURN' | 'DONE';
export type MissionEvent = 'DEPART' | 'LEG_CHANGE' | 'LANDED' | 'RETURN_START' | 'ARRIVED_HOME';

export interface MissionLegs {
  out: Leg[];
  back: Leg[];
  dwellSteps: number;
  departStep: number;
}

export interface MissionProgress {
  stage: MissionStage;
  legIndex: number;
  wpIndex: number;
  dwellUntilStep: number;
}

export const newProgress = (): MissionProgress => ({ stage: 'SCHEDULED', legIndex: 0, wpIndex: 1, dwellUntilStep: 0 });

export const isAirborneStage = (s: MissionStage) => s === 'OUTBOUND' || s === 'RETURN';

/** 위치 → 바람 벡터 (없으면 무풍) */
export type WindSampler = (p: Vec3) => Vec3;

/** step 번째 스텝을 처리한다. kin 과 pr 를 직접 갱신하고, 일어난 사건을 돌려준다 */

export function stepMission(
  m: MissionLegs,
  pr: MissionProgress,
  kin: KinematicState,
  step: number,
  lim: MotionLimits,
  dt: number,
  windAt?: WindSampler,
): MissionEvent | null {
  let ev: MissionEvent | null = null;
  if (pr.stage === 'SCHEDULED') {
    if (step < m.departStep) return null;
    pr.stage = 'OUTBOUND';
    pr.legIndex = 0;
    pr.wpIndex = 1;
    ev = 'DEPART';
  } else if (pr.stage === 'DWELL') {
    if (step < pr.dwellUntilStep) return null;
    pr.stage = 'RETURN';
    pr.legIndex = 0;
    pr.wpIndex = 1;
    ev = 'RETURN_START';
  }
  if (pr.stage !== 'OUTBOUND' && pr.stage !== 'RETURN') return ev;

  const legs = pr.stage === 'OUTBOUND' ? m.out : m.back;
  const res = stepAlongPath(kin, legs[pr.legIndex].waypoints, pr.wpIndex, lim, dt, windAt?.(kin.position));
  pr.wpIndex = res.wpIndex;
  if (!res.done) return ev;

  pr.legIndex++;
  pr.wpIndex = 1;
  if (pr.legIndex < legs.length) return ev ?? 'LEG_CHANGE';
  if (pr.stage === 'OUTBOUND') {
    pr.stage = 'DWELL';
    pr.dwellUntilStep = step + m.dwellSteps;
    return 'LANDED';
  }
  pr.stage = 'DONE';
  return 'ARRIVED_HOME';
}
