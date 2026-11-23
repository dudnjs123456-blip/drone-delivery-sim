# 드론 배송 3D 시뮬레이터

도심 아파트 단지에서 드론이 음식을 배송하는 과정을 3D로 시뮬레이션하고, 구간별 배송 시간을 측정한다.

## 실행

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # Vitest 단위 테스트
npm run typecheck
npm run lint
```

## 구조

- `src/sim/` — 시뮬레이션 로직 (순수 TS, React/three 의존 금지 — ESLint 로 강제)
  - `config.ts` — 모든 수치
  - `types.ts` — 핵심 타입, `engine/SimEngine.ts` — 엔진 인터페이스
  - `map/loadMap.ts` — map.json 검증·정규화
- `src/data/map.json` — 단지 데이터 (ENU 좌표, m)
- `src/components/` — 3D 렌더링·UI (`coords.ts` 에서만 ENU ↔ Three.js 변환)
- `src/store/` — zustand UI 상태

## 좌표계

ENU: x = 동, y = 북, z = 위 (m). 풍향은 "불어오는" 방향, 북 = 0, 시계 방향.
