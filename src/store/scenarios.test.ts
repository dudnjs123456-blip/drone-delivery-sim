import { beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '@/sim/config';
import { engine, useSimStore } from './simStore';

const DT = defaultConfig.time.fixedDtSec;

/** 엔진을 직접 돌리면서 UI 처럼 0.1초마다 publish 해 시나리오를 진행시킨다 */
function runToEnd(presetId: string) {
  const st = useSimStore.getState();
  const r = st.runScenario(presetId);
  if (!r.ok) throw new Error(r.text);
  for (let i = 0; i < 1300 / DT; i++) {
    engine.step(DT);
    if (i % 2 === 0) useSimStore.getState().publish();
    const sc = useSimStore.getState().scenario;
    if (sc?.stage === 'DONE') return sc;
  }
  throw new Error('시나리오가 끝나지 않았습니다');
}

describe('원클릭 시나리오 (기본 대응 정책)', () => {
  beforeEach(() => {
    useSimStore.getState().reset();
  });

  const cases: [string, { safe: boolean; delivered?: boolean }][] = [
    ['tfr', { safe: true, delivered: true }],
    ['crane', { safe: true, delivered: true }],
    ['heli', { safe: true, delivered: true }],
    ['heli-dark', { safe: false }],
    ['battery', { safe: true, delivered: false }],
    ['link', { safe: true, delivered: false }],
    ['station', { safe: true, delivered: true }],
  ];

  for (const [id, want] of cases) {
    it(`${id}: 돌발 상황이 들어가고 대응·결과가 나온다`, () => {
      const sc = runToEnd(id);
      expect(sc.hazardId).toBeDefined();
      expect(sc.result!.safe).toBe(want.safe);
      if (want.delivered !== undefined) expect(sc.result!.delivered).toBe(want.delivered);
      // 아무 반응 없이 끝나지 않는다: 대응 동작이 있거나(안전) 사고가 기록된다
      const texts = sc.result!.lines.map((l) => l.text).join(' ');
      expect(texts).not.toContain('대응 동작 없음');
      // 화면 알림이 생긴다
      expect(useSimStore.getState().toasts.length + useSimStore.getState().hazardLog.length).toBeGreaterThan(0);
    }, 60_000);
  }
});
