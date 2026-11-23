'use client';

import { defaultMap } from '@/sim/map/defaultMap';
import { lastMissionDurations } from '@/sim/metrics/phaseDurations';
import type { RouteConflict } from '@/sim/pathfinding/conflicts';
import type { FlightPhase } from '@/sim/types';
import { msToKmh } from '@/sim/util/units';
import { type DroneView, useSimStore } from '@/store/simStore';
import { useViewStore } from '@/store/viewStore';
import { phaseColor, phaseLabel } from '../phase';
import { routeConflicts } from '../routeConflicts';

const MISSION_PHASES: FlightPhase[] = ['TAKEOFF', 'CRUISE', 'DESCEND', 'LANDED', 'RETURN'];
const dockName = (id: string) => defaultMap.docks.find((d) => d.id === id)?.name ?? id;

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="rounded bg-slate-50 px-2 py-1">
      <div className="text-[10px] text-slate-500">{label}</div>
      <div className="font-mono text-sm tabular-nums text-slate-900">
        {value}
        {unit && <span className="ml-0.5 text-[10px] text-slate-500">{unit}</span>}
      </div>
    </div>
  );
}

interface RouteSummary {
  lengthM: number;
  straightM: number;
  estCruiseSec: number;
  expandedNodes: number;
  computeMs: number;
  waypoints?: number;
}

function RouteBox({ title, route, conflicts }: { title: string; route: RouteSummary; conflicts: RouteConflict[] }) {
  const detour = route.straightM > 0 ? (route.lengthM / route.straightM - 1) * 100 : 0;
  return (
    <div className="rounded border border-slate-200 px-2 py-1.5 text-xs">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-semibold text-slate-600">{title}</span>
        {conflicts.length === 0 ? (
          <span className="text-emerald-600">✓ 장애물 침범 없음</span>
        ) : (
          <span className="text-red-600">⚠ 침범 {conflicts.length}곳</span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-slate-700">
        <span>순항 거리</span>
        <span className="text-right font-mono tabular-nums">
          {route.lengthM.toFixed(0)}m <span className="text-slate-400">(직선 +{detour.toFixed(1)}%)</span>
        </span>
        <span>최소 순항 시간</span>
        <span className="text-right font-mono tabular-nums">{route.estCruiseSec.toFixed(1)}s</span>
        <span>A* 탐색</span>
        <span className="text-right font-mono tabular-nums">
          {route.expandedNodes === 0 ? '직선 (생략)' : `${route.expandedNodes.toLocaleString()}노드`} · {route.computeMs.toFixed(0)}ms
        </span>
      </div>
      {conflicts.length > 0 && (
        <div className="mt-1 text-red-600">
          {conflicts.map((c) => (c.kind === 'ALTITUDE' ? '고도 제한' : (c.name ?? c.id))).join(', ')}
        </div>
      )}
    </div>
  );
}

/** 대기 중일 때 선택한 출발·도착의 경로 미리보기 */
function PreviewBox() {
  const preview = useSimStore((s) => s.preview);
  if (!preview) return null;
  const r = preview.result;
  if (!r.ok) {
    return <div className="rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">경로 없음: {r.reason}</div>;
  }
  const a = r.path[0];
  const b = r.path[r.path.length - 1];
  return (
    <RouteBox
      title="출발 전 경로 미리보기"
      route={{
        lengthM: r.lengthM,
        straightM: Math.hypot(b.x - a.x, b.y - a.y),
        estCruiseSec: r.estFlightSec,
        expandedNodes: r.expanded,
        computeMs: r.computeMs,
      }}
      conflicts={routeConflicts(preview.fullPath)}
    />
  );
}

function DroneCard({ d }: { d: DroneView }) {
  const time = useSimStore((s) => s.time);
  const phaseLog = useSimStore((s) => s.phaseLog);
  const followDroneId = useViewStore((s) => s.followDroneId);
  const setFollow = useViewStore((s) => s.setFollow);
  const following = followDroneId === d.id;

  const hs = Math.hypot(d.velocity.x, d.velocity.y);
  const mission = lastMissionDurations(phaseLog, d.id, time);
  const conflicts = routeConflicts(d.path);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="font-bold text-slate-900">{d.id}</span>
        <span className="rounded px-1.5 py-0.5 text-xs font-semibold text-white" style={{ background: phaseColor[d.phase] }}>
          {phaseLabel[d.phase]}
        </span>
        <span className="text-xs text-slate-500">기지 {dockName(d.homeDockId)}</span>
        <button
          onClick={() => setFollow(following ? null : d.id)}
          className={`ml-auto rounded px-2 py-0.5 text-xs font-medium ${
            following ? 'bg-sky-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
          }`}
        >
          {following ? '따라가는 중' : '따라가기'}
        </button>
      </div>

      <div className="grid grid-cols-3 gap-1">
        <Stat label="고도" value={d.position.z.toFixed(1)} unit="m" />
        <Stat label="수평 속도" value={msToKmh(hs).toFixed(1)} unit="km/h" />
        <Stat label="수직 속도" value={(d.velocity.z >= 0 ? '+' : '') + d.velocity.z.toFixed(1)} unit="m/s" />
        <Stat label="탑재" value={d.payloadKg.toFixed(1)} unit="kg" />
        <Stat label="경로" value={d.path.length ? `${Math.min(d.pathIndex, d.path.length - 1)}/${d.path.length - 1}` : '-'} />
        <div className="rounded bg-slate-50 px-2 py-1">
          <div className="text-[10px] text-slate-500">배터리</div>
          <div className="mt-1 h-2 overflow-hidden rounded bg-slate-200">
            <div
              className={`h-full ${d.battery > 0.3 ? 'bg-emerald-500' : 'bg-red-500'}`}
              style={{ width: `${(d.battery * 100).toFixed(1)}%` }}
            />
          </div>
          <div className="font-mono text-[11px] tabular-nums text-slate-700">{(d.battery * 100).toFixed(1)}%</div>
        </div>
      </div>

      {d.route ? <RouteBox title="현재 비행 경로 (A*)" route={d.route} conflicts={conflicts} /> : d.phase === 'IDLE' && <PreviewBox />}

      {mission && (
        <div>
          <div className="mb-1 text-[11px] font-semibold text-slate-600">
            최근 임무 구간 시간 <span className="font-normal text-slate-400">(시뮬레이션 초)</span>
          </div>
          <table className="w-full text-xs">
            <tbody>
              {MISSION_PHASES.map((p) => {
                const v = mission.phases[p];
                const active = mission.current === p;
                return (
                  <tr key={p} className={active ? 'font-semibold text-slate-900' : 'text-slate-600'}>
                    <td className="py-0.5">
                      <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: phaseColor[p] }} />
                      {phaseLabel[p]}
                      {active && ' ●'}
                    </td>
                    <td className="text-right font-mono tabular-nums">{v === undefined ? '-' : v.toFixed(1)}</td>
                  </tr>
                );
              })}
              <tr className="border-t border-slate-200 text-slate-800">
                <td className="pt-1">편도 (이륙→착륙)</td>
                <td className="pt-1 text-right font-mono tabular-nums">{mission.outboundSec?.toFixed(1) ?? '-'}</td>
              </tr>
              <tr className="text-slate-800">
                <td>왕복 (이륙→복귀)</td>
                <td className="text-right font-mono tabular-nums">{mission.totalSec?.toFixed(1) ?? '-'}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function DronePanel() {
  const drones = useSimStore((s) => s.drones);
  return (
    <div className="w-80 rounded-lg bg-white/95 p-3 shadow-lg backdrop-blur">
      <div className="mb-2 text-sm font-bold text-slate-900">드론 상태</div>
      <div className="space-y-3">
        {drones.map((d) => (
          <DroneCard key={d.id} d={d} />
        ))}
      </div>
    </div>
  );
}
