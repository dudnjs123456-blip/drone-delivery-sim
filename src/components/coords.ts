/**
 * 시뮬레이션 좌표(ENU: x=동, y=북, z=위) ↔ Three.js 좌표(x=오른쪽, y=위, z=화면 앞쪽) 변환.
 * 좌표 변환은 이 파일에서만 한다.
 *   three.x =  E
 *   three.y =  U
 *   three.z = -N
 */
import type { Vec3 } from '@/sim/types';

export type ThreeTuple = [number, number, number];

export const enuToThree = (x: number, y: number, z: number): ThreeTuple => [x, z, -y];
export const vecToThree = (v: Vec3): ThreeTuple => [v.x, v.z, -v.y];
export const threeToEnu = (tx: number, ty: number, tz: number): Vec3 => ({ x: tx, y: -tz, z: ty });

/**
 * XY 평면에 그린 Shape 를 +Z 로 압출한 메시를 ENU 로 세우는 회전.
 * X축 기준 -90°: (E, N, U) → (E, U, -N)
 */
export const EXTRUDE_TO_ENU_ROTATION: ThreeTuple = [-Math.PI / 2, 0, 0];
