'use client';

import { useFrame, useThree } from '@react-three/fiber';
import { useMemo } from 'react';
import * as THREE from 'three';
import { type LabelSpec, labelElements } from './labels';

/** 매 프레임 라벨 앵커를 화면 좌표로 투영해 DOM 위치를 갱신한다 */
export function LabelProjector({ labels }: { labels: LabelSpec[] }) {
  const size = useThree((s) => s.size);
  const anchors = useMemo(() => labels.map((l) => ({ id: l.id, v: new THREE.Vector3(...l.anchor) })), [labels]);
  const tmp = useMemo(() => new THREE.Vector3(), []);

  useFrame(({ camera }) => {
    for (const a of anchors) {
      const el = labelElements.get(a.id);
      if (!el) continue;
      tmp.copy(a.v).project(camera);
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
