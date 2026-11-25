'use client';

import type { ResponsePolicies } from '@/sim/hazards/types';
import { SCENARIOS, type ScenarioStage } from '@/store/scenarios';
import { engine, useSimStore } from '@/store/simStore';
import { useViewStore } from '@/store/viewStore';
import { HAZARD_CATALOG } from '../hazardCatalog';
import { formatClock } from './SimControls';

const STEPS: { stage: ScenarioStage; label: string }[] = [
  { stage: 'LAUNCHING', label: '이륙' },
  { stage: 'CRUISING', label: '순항' },
  { stage: 'INJECTED', label: '돌발 상황 · 대응' },
  { stage: 'DONE', label: '결과' },
];
const tone = { good: 'text-emerald-700', bad: 'text-red-600', warn: 'text-amber-700', info: 'text-slate-700' };

export function ScenarioPanel() {
  const scenario = useSimStore((s) => s.scenario);
  const policies = useSimStore((s) => s.policies);
  const setPolicies = useSimStore((s) => s.setPolicies);
  const runScenario = useSimStore((s) => s.runScenario);
  const time = useSimStore((s) => s.time);
  const track = useViewStore((s) => s.track);
  const running = scenario && scenario.stage !== 'DONE';
  const preset = scenario ? SCENARIOS.find((p) => p.id === scenario.presetId) : null;
  const err = useSimStore((s) => s.message);

  const start = (id: string) => {
    const r = runScenario(id);
    if (!r.ok) return;
    const d = engine.getSnapshot().drones.find((x) => x.id === r.droneId);
    if (d) track({ kind: 'drone', id: d.id }, d.position.x, d.position.y, 160);
  };

  const stepIndex = scenario ? STEPS.findIndex((s) => s.stage === scenario.stage) : -1;

  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-sm font-bold text-slate-900">🎬 원클릭 시나리오</h2>
        <p className="text-[11px] leading-snug text-slate-500">
          누르면 드론이 떠서 순항에 들어간 뒤 바로 앞에 돌발 상황이 생기고, 카메라가 그 드론을 따라갑니다. 아래에서 대응 정책을 바꿔 다시 누르면
          결과를 비교할 수 있습니다.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-1">
        {SCENARIOS.map((p) => (
          <button
            key={p.id}
            onClick={() => start(p.id)}
            disabled={!!running}
            className={`rounded-md border px-2 py-1.5 text-left text-[11px] font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
              scenario?.presetId === p.id ? 'border-rose-400 bg-rose-50 text-rose-900' : 'border-slate-200 bg-white text-slate-800 hover:bg-slate-50'
            }`}
          >
            <span className="mr-1">{p.icon}</span>
            {p.title}
          </button>
        ))}
      </div>
      {err && !err.ok && !running && <div className="text-[11px] text-red-600">{err.text}</div>}

      {scenario && preset && (
        <div className={`space-y-1.5 rounded-lg border p-2 ${scenario.stage === 'DONE' ? (scenario.result?.safe ? 'border-emerald-300 bg-emerald-50/60' : 'border-red-300 bg-red-50/60') : 'border-amber-300 bg-amber-50/60'}`}>
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-bold text-slate-900">
              {preset.icon} {preset.title}
            </span>
            <button
              onClick={() => {
                const d = engine.getSnapshot().drones.find((x) => x.id === scenario.droneId);
                if (d) track({ kind: 'drone', id: d.id }, d.position.x, d.position.y, 160);
              }}
              className="ml-auto rounded bg-slate-800 px-2 py-0.5 text-[10px] font-medium text-white"
            >
              🎥 {scenario.droneId} 보기
            </button>
          </div>
          <p className="text-[11px] leading-snug text-slate-600">{preset.desc}</p>

          {/* 진행 단계 */}
          <div className="flex items-center gap-1 text-[10px]">
            {STEPS.map((s, i) => (
              <div key={s.stage} className="flex flex-1 items-center gap-1">
                <div
                  className={`flex-1 rounded px-1 py-0.5 text-center ${
                    i < stepIndex || scenario.stage === 'DONE'
                      ? 'bg-slate-700 text-white'
                      : i === stepIndex
                        ? 'animate-pulse bg-amber-500 font-semibold text-white'
                        : 'bg-slate-200 text-slate-500'
                  }`}
                >
                  {s.label}
                </div>
              </div>
            ))}
          </div>

          <label className="flex items-center gap-1.5 text-[11px] text-slate-700">
            <span className="shrink-0 font-medium">대응 정책</span>
            <select
              value={policies[preset.kind]}
              onChange={(e) => setPolicies({ [preset.kind]: e.target.value } as Partial<ResponsePolicies>)}
              className="w-full rounded border border-slate-200 bg-white px-1.5 py-0.5 text-xs"
            >
              {HAZARD_CATALOG[preset.kind].options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <p className="text-[10px] leading-snug text-slate-500">
            {HAZARD_CATALOG[preset.kind].options.find((o) => o.value === policies[preset.kind])?.desc}
          </p>
          {running && scenario.stage !== 'INJECTED' && <p className="text-[10px] text-amber-700">정책은 돌발 상황이 들어가기 전에 바꾸면 이번 실행에 적용됩니다.</p>}

          {scenario.stage === 'DONE' && scenario.result && (
            <div className="space-y-0.5 border-t border-slate-200 pt-1.5">
              <div className={`text-sm font-bold ${scenario.result.safe ? 'text-emerald-700' : 'text-red-600'}`}>
                {scenario.result.safe ? '✅ 안전하게 대응' : '❌ 사고 발생'}
                <span className="ml-2 text-[11px] font-normal text-slate-500">
                  정책 「{HAZARD_CATALOG[preset.kind].options.find((o) => o.value === scenario.policyLabel)?.label}」 · 소요 {formatClock(scenario.result.durationSec)}
                </span>
              </div>
              {scenario.result.lines.map((l, i) => (
                <div key={i} className={`text-[11px] ${tone[l.tone]}`}>
                  • {l.text}
                </div>
              ))}
              <button onClick={() => start(preset.id)} className="mt-1 w-full rounded-md bg-rose-600 py-1 text-xs font-semibold text-white hover:bg-rose-500">
                ↻ 지금 정책으로 다시 실행
              </button>
            </div>
          )}
          {running && <div className="text-right font-mono text-[10px] text-slate-400">경과 {formatClock(time - scenario.startedAt)}</div>}
        </div>
      )}
    </section>
  );
}
