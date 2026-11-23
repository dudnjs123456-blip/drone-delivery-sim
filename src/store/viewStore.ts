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
  camera: CameraInfo;
  /** 미니맵 클릭 등으로 요청된 카메라 이동. n 이 바뀔 때마다 한 번 처리한다 */
  focusRequest: { x: number; y: number; n: number } | null;
  setViewMode: (m: ViewMode) => void;
  toggleLabels: () => void;
  setCamera: (c: CameraInfo) => void;
  requestFocus: (x: number, y: number) => void;
}

export const useViewStore = create<ViewState>((set) => ({
  viewMode: '3D',
  showLabels: true,
  camera: { x: 0, y: 0, targetX: 0, targetY: 0 },
  focusRequest: null,
  setViewMode: (viewMode) => set({ viewMode }),
  toggleLabels: () => set((s) => ({ showLabels: !s.showLabels })),
  setCamera: (camera) => set({ camera }),
  requestFocus: (x, y) => set((s) => ({ focusRequest: { x, y, n: (s.focusRequest?.n ?? 0) + 1 } })),
}));
