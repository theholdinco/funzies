/**
 * Architecture-boundary AST enforcement.
 *
 * Forbids the specific UI re-derivation patterns that caused the April 2026
 * "missing €1.80M of interest residual" incident. Each rule encodes one
 * incident-pattern; per-occurrence opt-out via inline `// arch-boundary-allow: <ruleId>`.
 *
 * See CLAUDE.md § Engine ↔ UI separation.
 */

import { Project, SyntaxKind, Node } from "ts-morph";
import { describe, expect, it } from "vitest";
import { resolve } from "path";

const TSCONFIG_PATH = resolve(__dirname, "../../../tsconfig.json");

const ARITHMETIC_TOKENS = new Set<SyntaxKind>([
  SyntaxKind.AsteriskToken,
  SyntaxKind.SlashToken,
  SyntaxKind.PlusToken,
  SyntaxKind.MinusToken,
]);

function expressionContainsMember(node: Node, owner: string, member: string): boolean {
  let found = false;
  node.forEachDescendant((d) => {
    if (Node.isPropertyAccessExpression(d)) {
      const parent = d.getExpression();
      if (Node.isIdentifier(parent) && parent.getText() === owner && d.getName() === member) {
        found = true;
      }
    }
  });
  return found;
}

function expressionContainsAnyMember(node: Node, owner: string): boolean {
  let found = false;
  node.forEachDescendant((d) => {
    if (Node.isPropertyAccessExpression(d)) {
      const parent = d.getExpression();
      if (Node.isIdentifier(parent) && parent.getText() === owner) found = true;
    }
  });
  return found;
}

interface Rule {
  id: string;
  scope: RegExp;
  detect: (node: Node) => boolean;
  rationale: string;
}

const RULES: Rule[] = [
  {
    id: "ui-uses-inputs-in-arithmetic",
    scope: /web\/(app|components)\/clo\/.*\.(ts|tsx)$/,
    detect: (node) => {
      if (!Node.isBinaryExpression(node)) return false;
      if (!ARITHMETIC_TOKENS.has(node.getOperatorToken().getKind())) return false;
      return expressionContainsAnyMember(node, "inputs");
    },
    rationale:
      "Arithmetic involving inputs.<member> in a UI helper. Read from period.stepTrace.* instead.",
  },
  {
    id: "ui-back-derives-equity",
    scope: /web\/(app|components)\/clo\/.*\.(ts|tsx)$/,
    detect: (node) => {
      if (!Node.isBinaryExpression(node)) return false;
      if (node.getOperatorToken().getKind() !== SyntaxKind.MinusToken) return false;
      return expressionContainsMember(node, "period", "equityDistribution");
    },
    rationale:
      "Back-derivation from period.equityDistribution. Read period.stepTrace.equityFromInterest / equityFromPrincipal directly.",
  },
  {
    id: "ui-reads-raw-principal-cash",
    scope: /web\/(app|components)\/clo\/.*\.(ts|tsx)$/,
    detect: (node) => {
      if (!Node.isBinaryExpression(node)) return false;
      if (!ARITHMETIC_TOKENS.has(node.getOperatorToken().getKind())) return false;
      return expressionContainsMember(node, "resolved", "principalAccountCash");
    },
    rationale:
      "Reading raw resolver field with sign-convention invariant in arithmetic. Use result.initialState.equityBookValue (engine output) instead.",
  },
  {
    id: "ui-recomputes-book-value",
    scope: /web\/(app|components)\/clo\/.*\.(ts|tsx)$/,
    detect: (node) => {
      if (!Node.isCallExpression(node)) return false;
      const expr = node.getExpression();
      if (!Node.isPropertyAccessExpression(expr)) return false;
      if (expr.getExpression().getText() !== "Math" || expr.getName() !== "max") return false;
      const args = node.getArguments();
      if (args.length !== 2) return false;
      const text = args[1].getText();
      return /loans?\b/i.test(text) && /\bdebt\b/i.test(text);
    },
    rationale:
      "UI re-deriving equity book value. Read from result.initialState.equityBookValue.",
  },
];

function hasAllowComment(node: Node, ruleId: string): boolean {
  const sourceFile = node.getSourceFile();
  const lines = sourceFile.getFullText().split("\n");
  const nodeLine = node.getStartLineNumber() - 1;
  const marker = new RegExp(`arch-boundary-allow:\\s*${ruleId}\\b`);
  for (let i = nodeLine - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === "") continue;
    if (line.startsWith("//")) {
      if (marker.test(line)) return true;
      continue;
    }
    return false;
  }
  return false;
}

describe("UI does not re-derive engine values", () => {
  it("no AST violations under scoped UI files", () => {
    const project = new Project({ tsConfigFilePath: TSCONFIG_PATH });
    const violations: string[] = [];
    for (const rule of RULES) {
      const files = project.getSourceFiles().filter((f) => rule.scope.test(f.getFilePath()));
      for (const file of files) {
        file.forEachDescendant((node) => {
          if (rule.detect(node) && !hasAllowComment(node, rule.id)) {
            violations.push(
              `${file.getFilePath()}:${node.getStartLineNumber()} [${rule.id}] ${rule.rationale}`,
            );
          }
        });
      }
    }
    expect(violations).toEqual([]);
  });
});
