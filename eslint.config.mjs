import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // 시뮬레이션 로직(src/sim)은 렌더링·UI 계층에 의존하지 않는다 (엔진 교체 가능성 유지)
  {
    files: ["src/sim/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["react", "react-dom", "react/*"], message: "src/sim 은 React 에 의존하면 안 됩니다." },
            { group: ["three", "three/*", "@react-three/*"], message: "src/sim 은 three.js 에 의존하면 안 됩니다." },
            { group: ["next", "next/*", "zustand", "zustand/*"], message: "src/sim 은 UI 프레임워크에 의존하면 안 됩니다." },
            { group: ["@/components/*", "@/store/*", "@/app/*"], message: "src/sim 은 렌더링 계층을 import 하면 안 됩니다." },
          ],
        },
      ],
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);

export default eslintConfig;
