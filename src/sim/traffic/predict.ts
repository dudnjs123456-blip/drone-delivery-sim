/**
 * 임무 궤적 예측: 엔진과 같은 stepMission 을 출발 스텝 0 부터 끝까지 돌려
 * 비행 중(지상 제외) 위치를 시간 칸별 셀 목록(footprint)으로 만든다.
 */
import { type MotionLimits, stepAlongPath } from '../flight/kinematics';
import { type MissionLegs, type MissionProgress, isAirborneStage, newProgress, stepMission } from '../flight/mission';
import type { Vec3 } from '../types';
import type { Footprint, ReservationTable } from './reservationTable';

export interface MissionPrediction {
  /** 출발 스텝 기준 상대 스텝 */
  landedStep: number;
  returnStartStep: number;
  doneStep: number;
  airborneSteps: number;
  footprint: Footprint;
}

const MAX_STEPS = 60 * 60 * 20 * 2; // 50ms 기준 2시간 (경로 이상 시 무한 루프 방지)

export interface RemainingPrediction {
  /** 예측을 시작한 시간 칸 (footprint[0] 이 이 칸) */
  baseSlot: number;
  footprint: Footprint;
  /** 절대 스텝. 해당 사건이 이미 지났거나 없으면 null */
  landedStep: number | null;
  returnStartStep: number | null;
  doneStep: number;
}

/**
 * 비행 중인 임무의 남은 궤적 예측 (돌발 상황으로 경로·대기가 바뀐 뒤 재예약용).
 * hold 가 있으면 holdUntilStep 까지 hold 지점에 머문다고 가정한다 (보수적).
 */
export function predictRemaining(
  legs: MissionLegs,
  progress: MissionProgress,
  kinNow: { position: Vec3; velocity: Vec3 },
  stepNow: number,
  lim: MotionLimits,
  dt: number,
  stepsPerSlot: number,
  table: ReservationTable,
  hold: { point: Vec3; untilStep: number } | null,
): RemainingPrediction {
  const pr = { ...progress };
  const kin = { position: { ...kinNow.position }, velocity: { ...kinNow.velocity } };
  const baseSlot = Math.floor((stepNow + 1) / stepsPerSlot);
  const fp: Set<number>[] = [];
  let landedStep: number | null = null;
  let returnStartStep: number | null = null;
  const add = (step: number) => {
    const slot = Math.floor(step / stepsPerSlot) - baseSlot;
    while (fp.length <= slot) fp.push(new Set());
    fp[slot].add(table.cellKey(kin.position.x, kin.position.y, kin.position.z));
  };
  for (let step = stepNow + 1; step < stepNow + MAX_STEPS; step++) {
    if (hold && step < hold.untilStep) {
      stepAlongPath(kin, [hold.point, hold.point], 1, lim, dt);
      add(step);
      continue;
    }
    const ev = stepMission(legs, pr, kin, step, lim, dt);
    if (ev === 'LANDED') landedStep = step;
    if (ev === 'RETURN_START') returnStartStep = step;
    if (ev === 'ARRIVED_HOME') {
      return { baseSlot, footprint: fp.map((s) => [...s]), landedStep, returnStartStep, doneStep: step };
    }
    if (isAirborneStage(pr.stage)) add(step);
  }
  throw new Error('남은 임무 예측이 끝나지 않습니다');
}

export function predictMission(
  legs: Omit<MissionLegs, 'departStep'>,
  start: Vec3,
  lim: MotionLimits,
  dt: number,
  stepsPerSlot: number,
  table: ReservationTable,
): MissionPrediction {
  const m: MissionLegs = { ...legs, departStep: 0 };
  const pr = newProgress();
  const kin = { position: { ...start }, velocity: { x: 0, y: 0, z: 0 } };
  const fp: Set<number>[] = [];
  let landedStep = -1;
  let returnStartStep = -1;
  let airborneSteps = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    const ev = stepMission(m, pr, kin, step, lim, dt);
    if (ev === 'LANDED') landedStep = step;
    if (ev === 'RETURN_START') returnStartStep = step;
    if (ev === 'ARRIVED_HOME') {
      return {
        landedStep,
        returnStartStep,
        doneStep: step,
        airborneSteps,
        footprint: fp.map((s) => (s ? [...s] : [])),
      };
    }
    if (isAirborneStage(pr.stage)) {
      airborneSteps++;
      const slot = Math.floor(step / stepsPerSlot);
      while (fp.length <= slot) fp.push(undefined as unknown as Set<number>);
      (fp[slot] ??= new Set()).add(table.cellKey(kin.position.x, kin.position.y, kin.position.z));
    }
  }
  throw new Error('임무 예측이 끝나지 않습니다 (경로를 확인하세요)');
}
