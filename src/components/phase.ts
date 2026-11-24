import type { FlightPhase } from '@/sim/types';

export const phaseLabel: Record<FlightPhase, string> = {
  IDLE: '대기',
  TAKEOFF: '이륙',
  CRUISE: '순항',
  DESCEND: '하강',
  LANDED: '하역',
  RETURN: '복귀',
  HOLD: '공중 대기',
  FAILED: '운용 불가',
};

export const phaseColor: Record<FlightPhase, string> = {
  IDLE: '#64748b',
  TAKEOFF: '#16a34a',
  CRUISE: '#0891b2',
  DESCEND: '#ca8a04',
  LANDED: '#9333ea',
  RETURN: '#475569',
  HOLD: '#ea580c',
  FAILED: '#b91c1c',
};

export const isAirborne = (p: FlightPhase) =>
  p === 'TAKEOFF' || p === 'CRUISE' || p === 'DESCEND' || p === 'RETURN' || p === 'HOLD';
