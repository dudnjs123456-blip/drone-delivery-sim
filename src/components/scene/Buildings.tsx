'use client';

import { Edges } from '@react-three/drei';
import { useMemo } from 'react';
import * as THREE from 'three';
import type { Building } from '@/sim/types';
import { EXTRUDE_TO_ENU_ROTATION } from '../coords';
import { palette } from './palette';

function BuildingMesh({ building }: { building: Building }) {
  const geometry = useMemo(() => {
    const shape = new THREE.Shape(building.footprint.map(([x, y]) => new THREE.Vector2(x, y)));
    return new THREE.ExtrudeGeometry(shape, { depth: building.heightM, bevelEnabled: false });
  }, [building]);

  const isApt = building.kind === 'APARTMENT';

  return (
    // ExtrudeGeometry 그룹: 0 = 윗면·바닥면, 1 = 옆면
    <mesh geometry={geometry} rotation={EXTRUDE_TO_ENU_ROTATION} castShadow receiveShadow>
      <meshStandardMaterial attach="material-0" color={isApt ? palette.apartmentRoof : palette.commercialRoof} />
      <meshStandardMaterial attach="material-1" color={isApt ? palette.apartmentWall : palette.commercialWall} />
      <Edges threshold={15} color="#5b6470" />
    </mesh>
  );
}

export function Buildings({ buildings }: { buildings: Building[] }) {
  return (
    <>
      {buildings.map((b) => (
        <BuildingMesh key={b.id} building={b} />
      ))}
    </>
  );
}
