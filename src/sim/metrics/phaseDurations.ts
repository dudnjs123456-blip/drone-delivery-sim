import type { PhaseChange } from '../engine/SimEngine';
import type { FlightPhase } from '../types';

export interface MissionDurations {
  /** 단계별 소요 시간 (s). 진행 중인 단계는 now 까지 */
  phases: Partial<Record<FlightPhase, number>>;
  /** 이륙~스테이션 착륙 (착륙 전이면 undefined) */
  outboundSec?: number;
  /** 이륙~도크 복귀 (복귀 전이면 undefined) */
  totalSec?: number;
  startedAt: number;
  current: FlightPhase;
}

/** 드론의 가장 최근 임무(IDLE → TAKEOFF 부터)의 단계별 소요 시간 */
export function lastMissionDurations(log: readonly PhaseChange[], droneId: string, now: number): MissionDurations | null {
  const mine = log.filter((c) => c.droneId === droneId);
  let start = -1;
  for (let i = mine.length - 1; i >= 0; i--) {
    if (mine[i].from === 'IDLE' && mine[i].to === 'TAKEOFF') {
      start = i;
      break;
    }
  }
  if (start < 0) return null;

  const phases: Partial<Record<FlightPhase, number>> = {};
  let outboundSec: number | undefined;
  let totalSec: number | undefined;
  const t0 = mine[start].t;
  for (let i = start; i < mine.length; i++) {
    const c = mine[i];
    const end = i + 1 < mine.length ? mine[i + 1].t : now;
    if (c.to !== 'IDLE') phases[c.to] = (phases[c.to] ?? 0) + (end - c.t);
    if (c.to === 'LANDED' && outboundSec === undefined) outboundSec = c.t - t0;
    if (c.to === 'IDLE') {
      totalSec = c.t - t0;
      break;
    }
  }
  const last = mine[mine.length - 1];
  return { phases, outboundSec, totalSec, startedAt: t0, current: last.to };
}
