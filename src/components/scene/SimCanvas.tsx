'use client';

import { Grid } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import { defaultMap } from '@/sim/map/defaultMap';
import { defaultMapLabels } from '../labels/labels';
import { LabelProjector } from '../labels/LabelProjector';
import { enuToThree } from '../coords';
import { Buildings } from './Buildings';
import { CameraRig } from './CameraRig';
import { Docks, NoFlyZones, Stations, Stores } from './Facilities';
import { palette } from './palette';

export default function SimCanvas() {
  const map = defaultMap;
  const { minX, minY, maxX, maxY } = map.bounds;
  const w = maxX - minX;
  const d = maxY - minY;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  return (
    <Canvas
      // three r18x 에서 PCFSoftShadowMap 이 제거되어 PCF 사용
      shadows="percentage"
      dpr={[1, 2]}
      camera={{ fov: 50, near: 1, far: 5000, position: enuToThree(cx - 330, cy - 380, 300) }}
    >
      <color attach="background" args={[palette.sky]} />
      <fog attach="fog" args={[palette.sky, 1200, 3000]} />

      <hemisphereLight args={['#ffffff', '#8a9a7a', 0.9]} />
      <directionalLight
        position={enuToThree(cx - 250, cy - 150, 400)}
        intensity={1.6}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-450}
        shadow-camera-right={450}
        shadow-camera-top={450}
        shadow-camera-bottom={-450}
        shadow-camera-near={10}
        shadow-camera-far={1500}
        shadow-bias={-0.0005}
      />

      {/* 바닥: 단지 영역 + 주변 여백 */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={enuToThree(cx, cy, -0.05)} receiveShadow>
        <planeGeometry args={[w + 400, d + 400]} />
        <meshStandardMaterial color={palette.ground} />
      </mesh>
      <Grid
        position={enuToThree(cx, cy, 0.02)}
        args={[w, d]}
        cellSize={10}
        cellThickness={0.5}
        cellColor="#8f9a87"
        sectionSize={50}
        sectionThickness={1}
        sectionColor="#6f7a68"
        fadeDistance={2500}
        infiniteGrid={false}
      />

      <Buildings buildings={map.buildings} />
      <Docks docks={map.docks} />
      <Stations stations={map.stations} />
      <Stores stores={map.stores} />
      <NoFlyZones zones={map.noFlyZones} />

      <LabelProjector labels={defaultMapLabels} />

      <CameraRig map={map} />
    </Canvas>
  );
}
