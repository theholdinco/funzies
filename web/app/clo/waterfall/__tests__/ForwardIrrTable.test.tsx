/**
 * Render tests for the Forward IRR card body — pins the grid layout's
 * three production states (with-call comparison, single-column fallback,
 * and conservative-encoding wiring through to the rendered HTML).
 *
 * Replaces the prior `SideBySideIrr.test.tsx` render tests, which
 * targeted a component that no longer reaches the production UI.
 */

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ForwardIrrTable, type ForwardIrrRow } from "../ForwardIrrTable";
import type { FairValueResult } from "@/lib/clo/services";

const baseRows: ForwardIrrRow[] = [
  { label: "@ cost basis", cents: 95, noCall: 0.05, withCall: 0.07 },
  { label: "@ book", cents: 70, noCall: 0.12, withCall: 0.14 },
];

const convergedFv = (priceCents: number): FairValueResult => ({
  hurdle: 0.10,
  status: "converged",
  priceCents,
  iterations: 0,
});

describe("ForwardIrrTable — with-call comparison (3-column grid)", () => {
  it("renders explicit column headers with the formatted call date", () => {
    const html = renderToStaticMarkup(
      <ForwardIrrTable
        rows={baseRows}
        fairValueNoCall={convergedFv(50)}
        fairValueWithCall={convergedFv(55)}
        hasWithCall={true}
        withCallDate="2026-04-30"
        customEntryIrr={null}
        customEntryPriceCents={null}
      />,
    );
    expect(html).toContain("no call");
    expect(html).toContain("called Apr &#x27;26");
  });

  it("does NOT use new Date() — timezone-independent month at year boundaries", () => {
    // Regression: `new Date("2027-01-01")` parses UTC and rolls back to
    // Dec 2026 in negative-UTC zones. formatCallDate slices the ISO directly.
    const html = renderToStaticMarkup(
      <ForwardIrrTable
        rows={baseRows}
        fairValueNoCall={null}
        fairValueWithCall={null}
        hasWithCall={true}
        withCallDate="2027-01-01"
        customEntryIrr={null}
        customEntryPriceCents={null}
      />,
    );
    expect(html).toContain("Jan &#x27;27");
    expect(html).not.toContain("Dec &#x27;26");
  });

  it("renders 3 grid columns (label · no-call · with-call) when hasWithCall=true", () => {
    const html = renderToStaticMarkup(
      <ForwardIrrTable
        rows={baseRows}
        fairValueNoCall={null}
        fairValueWithCall={null}
        hasWithCall={true}
        withCallDate="2026-04-30"
        customEntryIrr={null}
        customEntryPriceCents={null}
      />,
    );
    expect(html).toMatch(/grid-template-columns:\s*1fr\s+auto\s+auto/);
  });

  it("conservative side renders bold (font-weight:700); higher side dims (opacity:0.55)", () => {
    // Row 1: noCall 5% < withCall 7% → noCall bold, withCall dim
    // Row 2: noCall 12% < withCall 14% → noCall bold, withCall dim
    const html = renderToStaticMarkup(
      <ForwardIrrTable
        rows={baseRows}
        fairValueNoCall={null}
        fairValueWithCall={null}
        hasWithCall={true}
        withCallDate="2026-04-30"
        customEntryIrr={null}
        customEntryPriceCents={null}
      />,
    );
    // Both no-call values render bold.
    expect(html).toMatch(/font-weight:\s*700[^"]*"[^>]*>5\.00%/);
    expect(html).toMatch(/font-weight:\s*700[^"]*"[^>]*>12\.00%/);
    // Both with-call values render dimmed.
    expect(html).toMatch(/opacity:\s*0\.55[^"]*"[^>]*>7\.00%/);
    expect(html).toMatch(/opacity:\s*0\.55[^"]*"[^>]*>14\.00%/);
  });

  it("equal numerics → neither bold nor dim (regression: prior fair-value branch dimmed both)", () => {
    // Bug repro: prior inline implementation dimmed both columns when prices were equal.
    const html = renderToStaticMarkup(
      <ForwardIrrTable
        rows={[]}
        fairValueNoCall={convergedFv(50)}
        fairValueWithCall={convergedFv(50)}
        hasWithCall={true}
        withCallDate="2026-04-30"
        customEntryIrr={null}
        customEntryPriceCents={null}
      />,
    );
    // Neither price renders dimmed — equal values are incomparable.
    expect(html).not.toMatch(/opacity:\s*0\.55[^"]*"[^>]*>50c/);
    // Neither bolded either.
    expect(html).not.toMatch(/font-weight:\s*700[^"]*"[^>]*>50c/);
  });

  it("renders the card-level legend exactly once", () => {
    const html = renderToStaticMarkup(
      <ForwardIrrTable
        rows={baseRows}
        fairValueNoCall={convergedFv(50)}
        fairValueWithCall={convergedFv(55)}
        hasWithCall={true}
        withCallDate="2026-04-30"
        customEntryIrr={null}
        customEntryPriceCents={null}
      />,
    );
    const legendOccurrences = html.match(/bold = more conservative/g) ?? [];
    expect(legendOccurrences.length).toBe(1);
  });

  it("renders the @ custom row with divider when customEntryIrr is provided", () => {
    const html = renderToStaticMarkup(
      <ForwardIrrTable
        rows={baseRows}
        fairValueNoCall={null}
        fairValueWithCall={null}
        hasWithCall={true}
        withCallDate="2026-04-30"
        customEntryIrr={{ noCall: 0.08, withCall: 0.06 }}
        customEntryPriceCents={62}
      />,
    );
    expect(html).toContain("@ custom (62c)");
    // Custom-row cells include border-top divider.
    expect(html).toMatch(/border-top:\s*1px\s+solid/);
  });

  it("renders fair-value row with status text when not converged", () => {
    const html = renderToStaticMarkup(
      <ForwardIrrTable
        rows={[]}
        fairValueNoCall={{ hurdle: 0.10, status: "below_hurdle", priceCents: null, iterations: 0 }}
        fairValueWithCall={{ hurdle: 0.10, status: "above_max_bracket", priceCents: null, iterations: 0 }}
        hasWithCall={true}
        withCallDate="2026-04-30"
        customEntryIrr={null}
        customEntryPriceCents={null}
      />,
    );
    expect(html).toContain("below hurdle");
    expect(html).toContain("exceeds 200c");
  });
});

describe("ForwardIrrTable — single-column (no-with-call deal)", () => {
  it("renders 2 grid columns when hasWithCall=false", () => {
    const html = renderToStaticMarkup(
      <ForwardIrrTable
        rows={baseRows}
        fairValueNoCall={convergedFv(50)}
        fairValueWithCall={null}
        hasWithCall={false}
        withCallDate={null}
        customEntryIrr={null}
        customEntryPriceCents={null}
      />,
    );
    expect(html).toMatch(/grid-template-columns:\s*1fr\s+auto[^"]*"/);
    expect(html).not.toMatch(/grid-template-columns:\s*1fr\s+auto\s+auto/);
  });

  it("does not render column headers, legend, or with-call cells", () => {
    const html = renderToStaticMarkup(
      <ForwardIrrTable
        rows={baseRows}
        fairValueNoCall={convergedFv(50)}
        fairValueWithCall={null}
        hasWithCall={false}
        withCallDate={null}
        customEntryIrr={null}
        customEntryPriceCents={null}
      />,
    );
    expect(html).not.toContain("no call");
    expect(html).not.toContain("called");
    expect(html).not.toContain("bold = more conservative");
    // Only one numeric value per row (no-call), no bold/dim encoding.
    expect(html).not.toMatch(/font-weight:\s*700/);
    expect(html).not.toMatch(/opacity:\s*0\.55/);
  });

  it("renders all data rows including fair-value and custom", () => {
    const html = renderToStaticMarkup(
      <ForwardIrrTable
        rows={baseRows}
        fairValueNoCall={convergedFv(45)}
        fairValueWithCall={null}
        hasWithCall={false}
        withCallDate={null}
        customEntryIrr={{ noCall: 0.08, withCall: undefined }}
        customEntryPriceCents={62}
      />,
    );
    expect(html).toContain("@ cost basis (95c)");
    expect(html).toContain("@ book (70c)");
    expect(html).toContain("@ fair value-10%");
    expect(html).toContain("45c");
    expect(html).toContain("@ custom (62c)");
  });
});

describe("ForwardIrrTable — null/undefined cell values", () => {
  it("renders em-dash for null IRRs", () => {
    const html = renderToStaticMarkup(
      <ForwardIrrTable
        rows={[{ label: "@ cost basis", cents: 95, noCall: null, withCall: null }]}
        fairValueNoCall={null}
        fairValueWithCall={null}
        hasWithCall={true}
        withCallDate="2026-04-30"
        customEntryIrr={null}
        customEntryPriceCents={null}
      />,
    );
    const dashes = html.match(/—/g) ?? [];
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });

  it("does not bold/dim when one side is null and the other numeric (incomparable)", () => {
    const html = renderToStaticMarkup(
      <ForwardIrrTable
        rows={[{ label: "@ cost basis", cents: 95, noCall: 0.05, withCall: null }]}
        fairValueNoCall={null}
        fairValueWithCall={null}
        hasWithCall={true}
        withCallDate="2026-04-30"
        customEntryIrr={null}
        customEntryPriceCents={null}
      />,
    );
    expect(html).not.toMatch(/font-weight:\s*700/);
    expect(html).not.toMatch(/opacity:\s*0\.55/);
  });
});
