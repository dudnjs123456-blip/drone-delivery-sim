'use client';

import { defaultMap } from '@/sim/map/defaultMap';
import { useViewStore } from '@/store/viewStore';

/** 카메라가 무엇을 따라가는 중인지 + 그만 따라가기 */
export function FollowChip() {
  const droneId = useViewStore((s) => s.followDroneId);
  const runnerId = useViewStore((s) => s.followRunnerId);
  const viewMode = useViewStore((s) => s.viewMode);
  const stop = useViewStore((s) => s.stopFollow);
  if (viewMode === 'FPV' || (!droneId && !runnerId)) return null;
  const store = runnerId ? defaultMap.stores.find((s) => runnerId.startsWith(s.id)) : null;
  const label = droneId ? `드론 ${droneId}` : `${store?.name ?? ''} 운반 직원`;
  return (
    <div className="pointer-events-auto absolute left-1/2 top-4 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full bg-slate-900/85 px-3 py-1 text-xs text-white shadow-lg">
      <span className="h-2 w-2 animate-pulse rounded-full bg-rose-400" />
      🎥 {label} 따라가는 중
      <button onClick={stop} className="rounded-full bg-white/15 px-2 py-0.5 hover:bg-white/30">
        그만
      </button>
    </div>
  );
}
