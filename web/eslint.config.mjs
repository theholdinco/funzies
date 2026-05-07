import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Promote react-hooks/exhaustive-deps to error project-wide. The default
  // Next.js config ships this as a warning. UI-side memos whose output is
  // consumed by runProjection are part of the model's correctness surface
  // (a missing dep silently freezes a slider — engine runs on stale input,
  // partner sees a number that doesn't match the dial). Anchored by
  // CLAUDE.md § "Recurring failure modes" principle 6 ("Missing memoization
  // deps are silent").
  {
    rules: {
      "react-hooks/exhaustive-deps": "error",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "public/gcc/assets/**",
    "worker/dist/**",
  ]),
]);

export default eslintConfig;
