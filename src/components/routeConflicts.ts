import { defaultConfig } from '@/sim/config';
import { defaultMap } from '@/sim/map/defaultMap';
import { type RouteConflict, findRouteConflicts } from '@/sim/pathfinding/conflicts';
import type { Vec3 } from '@/sim/types';

/** 엔진은 비행마다 새 경로 배열을 만들므로 배열 참조로 캐시한다 */
const cache = new WeakMap<readonly Vec3[], RouteConflict[]>();

export function routeConflicts(path: readonly Vec3[]): RouteConflict[] {
  let c = cache.get(path);
  if (!c) {
    c = path.length >= 2 ? findRouteConflicts(defaultMap, path, defaultConfig.altitude.maxM) : [];
    cache.set(path, c);
  }
  return c;
}
