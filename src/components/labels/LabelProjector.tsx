'use client';

import { useFrame, useThree } from '@react-three/fiber';
import { useMemo } from 'react';
import * as THREE from 'three';
import { labelAnchors, labelElements } from './labels';

/** 매 프레임 등록된 모든 라벨의 앵커를 화면 좌표로 투영해 DOM 위치를 갱신한다 */
export function LabelProjector() {
  const size = useThree((s) => s.size);
  const tmp = useMemo(() => new THREE.Vector3(), []);

  useFrame(({ camera }) => {
    for (const [id, el] of labelElements) {
      const anchor = labelAnchors.get(id);
      if (!anchor) {
        el.style.visibility = 'hidden';
        continue;
      }
      tmp.copy(anchor).project(camera);
      // 카메라 뒤쪽이거나 화면 밖이면 숨긴다
      if (tmp.z > 1 || tmp.x < -1.2 || tmp.x > 1.2 || tmp.y < -1.2 || tmp.y > 1.2) {
        el.style.visibility = 'hidden';
        continue;
      }
      const x = (tmp.x * 0.5 + 0.5) * size.width;
      const y = (-tmp.y * 0.5 + 0.5) * size.height;
      el.style.visibility = 'visible';
      el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
      // 가까운 라벨이 위에 오도록
      el.style.zIndex = String(Math.round((1 - tmp.z) * 100000));
    }
  });

  return null;
}
