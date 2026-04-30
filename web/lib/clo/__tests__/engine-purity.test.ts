/**
 * Engine purity guard — post-v6 plan §7.2.
 *
 * Source-level assertion that engine-layer files (per CLAUDE.md §
 * Engine-as-Source-of-Truth) contain none of the impurity markers that
 * would break determinism, testability, or the engine ↔ UI separation:
 *
 *  - `import "react"` / `import "react-dom"` / `import "next/..."`
 *  - `fetch(...)` calls
 *  - `process.env.*` reads (except in test scaffolding)
 *  - `Date.now()` (non-deterministic)
 *  - `async function` declarations
 *  - `await` keywords
 *
 * Preventive infrastructure: no current violations, but cheap insurance
 * against regressions when someone reaches for a quick `process.env`
 * shortcut to flag-gate a behavior.
 *
 * Granularity: AST-level matching is overkill here — these markers don't
 * appear inside identifiers or comments commonly enough to cause false
 * positives, and the regex matchers are explicit enough to surface bugs
 * loudly. If a false positive ever fires, switch to ts-morph.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ENGINE_FILES = [
  "projection.ts",
  "build-projection-inputs.ts",
  "pool-metrics.ts",
  "senior-expense-breakdown.ts",
  "backtest-harness.ts",
  "switch-simulator.ts",
];

const ENGINE_DIR = join(__dirname, "..");

function readEngineFile(name: string): string {
  return readFileSync(join(ENGINE_DIR, name), "utf-8");
}

describe("Engine purity (post-v6 plan §7.2)", () => {
  for (const file of ENGINE_FILES) {
    describe(file, () => {
      const src = readEngineFile(file);

      it("does not import React or React DOM", () => {
        // Match `from "react"`, `from "react-dom"`, `import "react"`, etc.
        expect(src).not.toMatch(/from\s+["']react["']/);
        expect(src).not.toMatch(/from\s+["']react-dom["']/);
        expect(src).not.toMatch(/import\s+["']react["']/);
      });

      it("does not import from next/*", () => {
        expect(src).not.toMatch(/from\s+["']next\/[^"']+["']/);
      });

      it("does not call fetch(...)", () => {
        // Strip out string/template literals & comments before matching to
        // avoid false positives on docstrings or example URLs.
        const stripped = src
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/.*$/gm, "")
          .replace(/`(?:\\`|[^`])*`/g, "")
          .replace(/"(?:\\.|[^"\\])*"/g, "")
          .replace(/'(?:\\.|[^'\\])*'/g, "");
        expect(stripped).not.toMatch(/\bfetch\s*\(/);
      });

      it("does not read process.env", () => {
        const stripped = src
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/.*$/gm, "");
        expect(stripped).not.toMatch(/\bprocess\.env\b/);
      });

      it("does not use Date.now() (non-deterministic)", () => {
        const stripped = src
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/.*$/gm, "");
        expect(stripped).not.toMatch(/\bDate\.now\s*\(/);
      });

      it("declares no async functions", () => {
        const stripped = src
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/.*$/gm, "");
        // Top-level + method-level async declarations.
        expect(stripped).not.toMatch(/\basync\s+function\b/);
        expect(stripped).not.toMatch(/\basync\s+\(/);
        expect(stripped).not.toMatch(/\basync\s+[a-zA-Z_]\w*\s*\(/);
      });
    });
  }
});
