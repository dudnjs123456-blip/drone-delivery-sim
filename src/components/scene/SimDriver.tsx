'use client';

import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import { runner, useSimStore } from '@/store/simStore';

const PUBLISH_INTERVAL_SEC = 0.1;

/**
 * 렌더 루프에서 시뮬레이션을 진행시킨다. 캔버스의 첫 자식으로 두어
 * 같은 프레임의 다른 useFrame(드론·카메라)보다 먼저 실행되게 한다.
 */
export function SimDriver() {
  const acc = useRef(0);
  useFrame((_, delta) => {
    runner.advance(delta);
    acc.current += delta;
    if (acc.current >= PUBLISH_INTERVAL_SEC) {
      acc.current = 0;
      useSimStore.getState().publish();
    }
  });
  return null;
}
