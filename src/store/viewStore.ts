import { create } from 'zustand';

export type ViewMode = '3D' | 'TOP';

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
  showLabels: boolean;
  /** A* 격자 경로(평활화 전) 표시 */
  showRawPath: boolean;
  camera: CameraInfo;
  /** 미니맵 클릭 등으로 요청된 카메라 이동. n 이 바뀔 때마다 한 번 처리한다 */
  focusRequest: { x: number; y: number; n: number } | null;
  /** 카메라가 따라갈 드론 id */
  followDroneId: string | null;
  /** 패널에서 선택한 드론 (경로 상세 표시) */
  selectedDroneId: string | null;
  setViewMode: (m: ViewMode) => void;
  toggleLabels: () => void;
  toggleRawPath: () => void;
  setCamera: (c: CameraInfo) => void;
  requestFocus: (x: number, y: number) => void;
  setFollow: (id: string | null) => void;
  setSelected: (id: string | null) => void;
}

export const useViewStore = create<ViewState>((set) => ({
  viewMode: '3D',
  showLabels: true,
  showRawPath: true,
  camera: { x: 0, y: 0, targetX: 0, targetY: 0 },
  focusRequest: null,
  followDroneId: null,
  selectedDroneId: null,
  setViewMode: (viewMode) => set({ viewMode }),
  toggleLabels: () => set((s) => ({ showLabels: !s.showLabels })),
  toggleRawPath: () => set((s) => ({ showRawPath: !s.showRawPath })),
  setCamera: (camera) => set({ camera }),
  // 다른 곳으로 이동하면 따라가기를 끈다
  requestFocus: (x, y) => set((s) => ({ focusRequest: { x, y, n: (s.focusRequest?.n ?? 0) + 1 }, followDroneId: null })),
  setFollow: (followDroneId) => set((s) => ({ followDroneId, selectedDroneId: followDroneId ?? s.selectedDroneId })),
  setSelected: (selectedDroneId) => set({ selectedDroneId }),
}));
