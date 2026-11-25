/**
 * 임무 궤적 예측: 엔진과 같은 stepMission 을 출발 스텝 0 부터 끝까지 돌려
 * 비행 중(지상 제외) 위치를 시간 칸별 셀 목록(footprint)으로 만든다.
 */
import { type MotionLimits, stepAlongPath } from '../flight/kinematics';
import { type MissionLegs, type MissionProgress, type WindSampler, isAirborneStage, newProgress, stepMission } from '../flight/mission';
import type { Vec3 } from '../types';
import type { Footprint, ReservationTable } from './reservationTable';

export interface MissionPrediction {
  /** 출발 스텝 기준 상대 스텝 */
  landedStep: number;
  /** 스테이션으로 하강을 시작하는 스텝 (스테이션 패드 점유 시작) */
  outDescendStep: number;
  /** 도크로 하강을 시작하는 스텝 (도크 패드 점유 시작) */
  backDescendStep: number;
  returnStartStep: number;
  doneStep: number;
  airborneSteps: number;
  footprint: Footprint;
}

const MAX_STEPS = 40 * 60 * 20; // 50ms 기준 40분 (강풍 등으로 끝나지 않는 경로 방지)

export interface RemainingPrediction {
  /** 예측을 시작한 시간 칸 (footprint[0] 이 이 칸) */
  baseSlot: number;
  footprint: Footprint;
  /** 절대 스텝. 해당 사건이 이미 지났거나 없으면 null */
  landedStep: number | null;
  returnStartStep: number | null;
  /** 하강 시작 (이미 하강 중이거나 지났으면 null) */
  outDescendStep: number | null;
  backDescendStep: number | null;
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
  windAt?: WindSampler,
  buffer: WindBuffer = { time: false, marginM: 0 },
): RemainingPrediction {
  const pr = { ...progress };
  const kin = { position: { ...kinNow.position }, velocity: { ...kinNow.velocity } };
  const baseSlot = Math.floor((stepNow + 1) / stepsPerSlot);
  const fp: Set<number>[] = [];
  let landedStep: number | null = null;
  let returnStartStep: number | null = null;
  let outDescendStep: number | null = null;
  let backDescendStep: number | null = null;
  const add = (step: number) => {
    const slot = Math.floor(step / stepsPerSlot) - baseSlot;
    while (fp.length <= slot) fp.push(new Set());
    cellsAround(table, kin.position.x, kin.position.y, kin.position.z, buffer.marginM, fp[slot]);
  };
  for (let step = stepNow + 1; step < stepNow + MAX_STEPS; step++) {
    if (hold && step < hold.untilStep) {
      stepAlongPath(kin, [hold.point, hold.point], 1, lim, dt, windAt?.(kin.position));
      add(step);
      continue;
    }
    const ev = stepMission(legs, pr, kin, step, lim, dt, windAt);
    if (ev === 'LANDED') landedStep = step;
    if (ev === 'RETURN_START') returnStartStep = step;
    if (ev === 'LEG_CHANGE') {
      if (pr.stage === 'OUTBOUND' && legs.out[pr.legIndex]?.kind === 'DESCEND') outDescendStep = step;
      if (pr.stage === 'RETURN' && legs.back[pr.legIndex]?.kind === 'DESCEND') backDescendStep = step;
    }
    if (ev === 'ARRIVED_HOME') {
      return {
        baseSlot,
        footprint: dilate(
          fp.map((s) => [...s]),
          buffer.time,
        ),
        landedStep,
        returnStartStep,
        outDescendStep,
        backDescendStep,
        doneStep: step,
      };
    }
    if (isAirborneStage(pr.stage)) add(step);
  }
  throw new Error('남은 임무 예측이 끝나지 않습니다');
}

/** 바람 속 예약 여유: 시간(앞뒤 칸)과 공간(예측 위치 주변 marginM) */
export interface WindBuffer {
  time: boolean;
  marginM: number;
}

/** 예측 위치 p 주변 margin 안의 셀들 (8 꼭짓점 + 중심) */
function cellsAround(table: ReservationTable, x: number, y: number, z: number, m: number, out: Set<number>) {
  out.add(table.cellKey(x, y, z));
  if (m <= 0) return;
  for (const dx of [-m, m]) for (const dy of [-m, m]) for (const dz of [-m, m]) out.add(table.cellKey(x + dx, y + dy, z + dz));
}

/**
 * 바람이 있으면 실제 비행이 돌풍으로 예측보다 조금 이르거나 늦을 수 있으므로,
 * 각 시간 칸에 앞뒤 칸의 셀까지 함께 예약한다 (시간 여유).
 */
function dilate(fp: Footprint, on: boolean): Footprint {
  if (!on) return fp;
  return fp.map((cells, i) => [...new Set([...(fp[i - 1] ?? []), ...cells, ...(fp[i + 1] ?? [])])]);
}

export function predictMission(
  legs: Omit<MissionLegs, 'departStep'>,
  start: Vec3,
  lim: MotionLimits,
  dt: number,
  stepsPerSlot: number,
  table: ReservationTable,
  windAt?: WindSampler,
  buffer: WindBuffer = { time: false, marginM: 0 },
): MissionPrediction {
  const m: MissionLegs = { ...legs, departStep: 0 };
  const pr = newProgress();
  const kin = { position: { ...start }, velocity: { x: 0, y: 0, z: 0 } };
  const fp: Set<number>[] = [];
  let landedStep = -1;
  let returnStartStep = -1;
  let outDescendStep = -1;
  let backDescendStep = -1;
  let airborneSteps = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    const ev = stepMission(m, pr, kin, step, lim, dt, windAt);
    if (ev === 'LANDED') landedStep = step;
    if (ev === 'RETURN_START') returnStartStep = step;
    if (ev === 'LEG_CHANGE') {
      if (pr.stage === 'OUTBOUND' && m.out[pr.legIndex]?.kind === 'DESCEND') outDescendStep = step;
      if (pr.stage === 'RETURN' && m.back[pr.legIndex]?.kind === 'DESCEND') backDescendStep = step;
    }
    if (ev === 'ARRIVED_HOME') {
      return {
        landedStep,
        returnStartStep,
        outDescendStep: outDescendStep < 0 ? landedStep : outDescendStep,
        backDescendStep: backDescendStep < 0 ? step : backDescendStep,
        doneStep: step,
        airborneSteps,
        footprint: dilate(
          fp.map((s) => (s ? [...s] : [])),
          buffer.time,
        ),
      };
    }
    if (isAirborneStage(pr.stage)) {
      airborneSteps++;
      const slot = Math.floor(step / stepsPerSlot);
      while (fp.length <= slot) fp.push(undefined as unknown as Set<number>);
      cellsAround(table, kin.position.x, kin.position.y, kin.position.z, buffer.marginM, (fp[slot] ??= new Set()));
    }
  }
  throw new Error('임무 예측이 끝나지 않습니다 (경로를 확인하세요)');
}
