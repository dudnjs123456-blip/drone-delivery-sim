import { create } from 'zustand';

/** 3D: 궤도(한 점을 중심으로 회전), TOP: 상단, FLY: 자유 비행 카메라, FPV: 선택한 드론 1인칭 */
export type ViewMode = '3D' | 'TOP' | 'FLY' | 'FPV';

interface CameraInfo {
  /** 카메라 위치 (ENU, m) */
  x: number;
  y: number;
  /** 카메라가 바라보는 지점 (ENU, m) */
  targetX: number;
  targetY: number;
}

interface ViewState {
  viewMode: ViewMode;
  /** FPV 로 들어가기 전 시점 (나올 때 돌아간다) */
  prevMode: Exclude<ViewMode, 'FPV'>;
  showLabels: boolean;
  /** A* 격자 경로(평활화 전) 표시 */
  showRawPath: boolean;
  camera: CameraInfo;
  /** 미니맵 클릭 등으로 요청된 카메라 이동. n 이 바뀔 때마다 한 번 처리한다 */
  focusRequest: { x: number; y: number; n: number; dist?: number; from?: { x: number; y: number } } | null;
  /** 카메라가 따라갈 드론 id */
  followDroneId: string | null;
  /** 카메라가 따라갈 운반 직원 id */
  followRunnerId: string | null;
  /** 패널에서 선택한 드론 (경로 상세 표시) */
  selectedDroneId: string | null;
  /** 1인칭으로 볼 드론 */
  fpvDroneId: string | null;
  /** 미니맵 클릭으로 위치를 고르는 중이면 그 용도 */
  pickMode: 'hazard' | null;
  pickedPoint: { x: number; y: number } | null;
  /** 더블클릭한 지점을 궤도 회전 중심으로 (ENU) */
  pivotRequest: { x: number; y: number; z: number; n: number } | null;
  /** 자유 비행 속도 (m/s) */
  flySpeed: number;
  /** 바람 화살표·입자·빌딩풍 표시 */
  showWind: boolean;
  /** 바람 화살표를 그릴 고도 (m) */
  windAlt: number;
  toggleWind: () => void;
  setWindAlt: (z: number) => void;
  requestPivot: (p: { x: number; y: number; z: number }) => void;
  setFlySpeed: (v: number) => void;
  setViewMode: (m: Exclude<ViewMode, 'FPV'>) => void;
  toggleLabels: () => void;
  toggleRawPath: () => void;
  setCamera: (c: CameraInfo) => void;
  /** dist 를 주면 그 거리까지 다가가고, from(ENU 방향)을 주면 그쪽에서 바라본다 */
  requestFocus: (x: number, y: number, dist?: number, from?: { x: number; y: number }) => void;
  setFollow: (id: string | null) => void;
  /** (x, y) 로 dist 거리까지 다가간 뒤 그 대상을 따라간다 */
  track: (target: { kind: 'drone' | 'runner'; id: string }, x: number, y: number, dist: number, from?: { x: number; y: number }) => void;
  stopFollow: () => void;
  setSelected: (id: string | null) => void;
  enterFpv: (droneId: string) => void;
  exitFpv: () => void;
  setPickMode: (m: 'hazard' | null) => void;
  setPicked: (p: { x: number; y: number } | null) => void;
}

export const useViewStore = create<ViewState>((set) => ({
  viewMode: '3D',
  prevMode: '3D',
  showLabels: true,
  showRawPath: true,
  camera: { x: 0, y: 0, targetX: 0, targetY: 0 },
  focusRequest: null,
  followDroneId: null,
  followRunnerId: null,
  selectedDroneId: null,
  fpvDroneId: null,
  pickMode: null,
  pickedPoint: null,
  pivotRequest: null,
  flySpeed: 40,
  showWind: true,
  windAlt: 60,
  toggleWind: () => set((s) => ({ showWind: !s.showWind })),
  setWindAlt: (windAlt) => set({ windAlt }),
  requestPivot: (p) => set((s) => ({ pivotRequest: { ...p, n: (s.pivotRequest?.n ?? 0) + 1 }, followDroneId: null, followRunnerId: null })),
  setFlySpeed: (flySpeed) => set({ flySpeed: Math.min(400, Math.max(2, flySpeed)) }),
  setViewMode: (viewMode) => set({ viewMode, prevMode: viewMode, fpvDroneId: null }),
  toggleLabels: () => set((s) => ({ showLabels: !s.showLabels })),
  toggleRawPath: () => set((s) => ({ showRawPath: !s.showRawPath })),
  setCamera: (camera) => set({ camera }),
  // 다른 곳으로 이동하면 따라가기를 끈다
  requestFocus: (x, y, dist, from) =>
    set((s) => ({ focusRequest: { x, y, dist, from, n: (s.focusRequest?.n ?? 0) + 1 }, followDroneId: null, followRunnerId: null })),
  setFollow: (followDroneId) => set((s) => ({ followDroneId, followRunnerId: null, selectedDroneId: followDroneId ?? s.selectedDroneId })),
  track: (target, x, y, dist, from) =>
    set((s) => ({
      focusRequest: { x, y, dist, from, n: (s.focusRequest?.n ?? 0) + 1 },
      followDroneId: target.kind === 'drone' ? target.id : null,
      followRunnerId: target.kind === 'runner' ? target.id : null,
      selectedDroneId: target.kind === 'drone' ? target.id : s.selectedDroneId,
      viewMode: s.viewMode === 'FPV' ? s.prevMode : s.viewMode,
      fpvDroneId: null,
    })),
  stopFollow: () => set({ followDroneId: null, followRunnerId: null }),
  setSelected: (selectedDroneId) => set({ selectedDroneId }),
  enterFpv: (fpvDroneId) =>
    set((s) => ({
      fpvDroneId,
      selectedDroneId: fpvDroneId,
      followDroneId: null,
      viewMode: 'FPV',
      prevMode: s.viewMode === 'FPV' ? s.prevMode : s.viewMode,
    })),
  exitFpv: () => set((s) => ({ viewMode: s.prevMode, fpvDroneId: null })),
  setPickMode: (pickMode) => set({ pickMode }),
  setPicked: (pickedPoint) => set({ pickedPoint, pickMode: null }),
}));
