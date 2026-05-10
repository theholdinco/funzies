import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth-helpers";
import { query } from "@/lib/db";
import { decryptApiKey } from "@/lib/crypto";
import {
  getAccountBalances,
  getAccruals,
  getHoldings,
  getIntexPositionsByReportPeriod,
  getParValueAdjustments,
  getReportPeriodData,
  getTrancheSnapshots,
  getTranches,
  verifyPanelAccess,
} from "@/lib/clo/access";
import { normalizeClassName } from "@/lib/clo/api";
import { resolveWaterfallInputs } from "@/lib/clo/resolver";
import type { ExtractedConstraints } from "@/lib/clo/types";
import { processAnthropicStream } from "@/lib/claude-stream";

interface ReportContextRow {
  id: string;
  latest_id: string | null;
  deal_id: string;
  deal_name: string | null;
  deal_currency: string | null;
  stated_maturity_date: string | Date | null;
  reinvestment_period_end: string | Date | null;
  report_date: string | Date | null;
  extracted_constraints: unknown;
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { panelId, dealContext } = body;
  const contextRecord = dealContext && typeof dealContext === "object" ? dealContext as Record<string, unknown> : {};

  if (!panelId) {
    return NextResponse.json({ error: "Missing panelId" }, { status: 400 });
  }

  const hasAccess = await verifyPanelAccess(panelId, user.id);
  if (!hasAccess) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const hasReportPeriodKey = Object.prototype.hasOwnProperty.call(contextRecord, "reportPeriodId");
  const reportPeriodValue = contextRecord.reportPeriodId;
  if (
    hasReportPeriodKey &&
    reportPeriodValue != null &&
    (typeof reportPeriodValue !== "string" || reportPeriodValue.trim() === "")
  ) {
    return NextResponse.json({ error: "Invalid reportPeriodId" }, { status: 400 });
  }
  const requestedReportPeriodId =
    typeof reportPeriodValue === "string" && reportPeriodValue.trim()
      ? reportPeriodValue.trim()
      : null;
  let reportContextRow: ReportContextRow | null = null;
  if (requestedReportPeriodId) {
    const periodRows = await query<ReportContextRow>(
      `SELECT
         rp.id,
         latest.id AS latest_id,
         d.id AS deal_id,
         d.deal_name,
         d.deal_currency,
         d.stated_maturity_date,
         d.reinvestment_period_end,
         rp.report_date,
         pr.extracted_constraints
       FROM clo_report_periods rp
       JOIN clo_deals d ON rp.deal_id = d.id
       JOIN clo_profiles pr ON d.profile_id = pr.id
       JOIN clo_panels p ON p.profile_id = pr.id
       LEFT JOIN LATERAL (
         SELECT id FROM clo_report_periods
         WHERE deal_id = d.id
         ORDER BY report_date DESC
         LIMIT 1
       ) latest ON true
       WHERE rp.id = $1 AND p.id = $2 AND pr.user_id = $3`,
      [requestedReportPeriodId, panelId, user.id],
    );
    if (periodRows.length === 0) {
      return NextResponse.json({ error: "Stale or inaccessible report period" }, { status: 409 });
    }
    if (periodRows[0].latest_id && periodRows[0].latest_id !== requestedReportPeriodId) {
      return NextResponse.json({ error: "Stale report period" }, { status: 409 });
    }
    reportContextRow = periodRows[0];
  } else if (hasReportPeriodKey) {
    const latestRows = await query<{ id: string }>(
      `SELECT rp.id
       FROM clo_panels p
       JOIN clo_profiles pr ON p.profile_id = pr.id
       JOIN clo_deals d ON d.profile_id = pr.id
       JOIN LATERAL (
         SELECT id
         FROM clo_report_periods
         WHERE deal_id = d.id
         ORDER BY report_date DESC
         LIMIT 1
       ) rp ON true
       WHERE p.id = $1 AND pr.user_id = $2`,
      [panelId, user.id],
    );
    if (latestRows.length > 0) {
      return NextResponse.json(
        { error: "Report data changed; refresh required" },
        { status: 409 },
      );
    }
  } else if (!hasReportPeriodKey) {
    const latestRows = await query<ReportContextRow>(
      `SELECT
         rp.id,
         rp.id AS latest_id,
         d.id AS deal_id,
         d.deal_name,
         d.deal_currency,
         d.stated_maturity_date,
         d.reinvestment_period_end,
         rp.report_date,
         pr.extracted_constraints
       FROM clo_panels p
       JOIN clo_profiles pr ON p.profile_id = pr.id
       JOIN clo_deals d ON d.profile_id = pr.id
       JOIN LATERAL (
         SELECT *
         FROM clo_report_periods
         WHERE deal_id = d.id
         ORDER BY report_date DESC
         LIMIT 1
       ) rp ON true
       WHERE p.id = $1 AND pr.user_id = $2`,
      [panelId, user.id],
    );
    reportContextRow = latestRows[0] ?? null;
  }

  const userRows = await query<{ encrypted_api_key: Buffer; api_key_iv: Buffer }>(
    "SELECT encrypted_api_key, api_key_iv FROM users WHERE id = $1",
    [user.id]
  );

  if (!userRows.length || !userRows[0].encrypted_api_key) {
    return NextResponse.json({ error: "No API key configured" }, { status: 400 });
  }

  const apiKey = decryptApiKey(userRows[0].encrypted_api_key, userRows[0].api_key_iv);

  const systemPrompt = `You are a CLO data quality analyst. Analyze the provided deal data and identify issues that could affect waterfall projection accuracy.

CLO structural knowledge (DO NOT flag these as issues):
- Subordinated Notes / Income Notes do NOT bear a fixed coupon or spread. They receive the RESIDUAL interest after all rated tranche coupons, fees, and coverage test diversions are paid. Seeing zero or null "interest paid" on sub notes is NORMAL — their distributions appear as residual equity distributions, not as interest. Do NOT flag this as an anomaly.
- Sub notes also have no spread (spreadBps=NULL is correct) and no reference rate. This is by design.
- Total tranche principal (original face value of all notes) will NOT match the current pool collateral balance. The pool balance changes constantly as loans repay, prepay, default, or are traded, while tranche balances only change through scheduled/unscheduled note payments. A mismatch between these two figures is completely normal — do NOT flag it as an error or warning.
- OC/IC actual ratios WILL differ from their trigger levels — that is expected. A passing test means actual > trigger. Do NOT flag a "mismatch" when the PPM trigger and the compliance report trigger agree but the actual ratio differs from the trigger. Only flag a true mismatch if the PPM-specified trigger LEVEL disagrees with the compliance report's trigger LEVEL for the same test class.
- Tranche currentBalance being lower than originalBalance is NORMAL — tranches amortize over time through principal payments. Only flag if currentBalance is HIGHER than originalBalance (indicates a data error or reset).
- WAC spread may appear as a small number (e.g. 3.85) when stored in percentage form rather than basis points. The model auto-converts values < 20 to bps (× 100). Do NOT flag a WAC spread between 1–20 as "abnormally low" — it is likely in percentage form (e.g. 3.85% = 385 bps).
- Test class name formatting varies between PPM and compliance reports (e.g. "Class E" vs "E", "Class A/B" vs "A/B"). The system normalizes these automatically. Do NOT flag minor naming differences as mismatches — only flag if a test class in the PPM has NO plausible match in the compliance data at all.
- Some tranches may be fixed-rate in a predominantly floating-rate deal. This is normal (hedged or structured as fixed). Do NOT flag fixed-rate tranches as unusual unless ALL rated tranches are unexpectedly fixed.
- Junior tranches (typically E and F) often have OC tests but NO IC tests. This is standard in European CLO structures. Do NOT flag missing IC tests on junior tranches as an issue. Only flag missing coverage tests if a SENIOR tranche (A, B, C) has no OC or IC test at all.

Check for these specific issues that affect the waterfall projection model:
1. Missing REQUIRED fields (severity=error): maturity date, tranche spreads on rated non-income notes, at least one OC or IC trigger level
2. Seniority rank problems: duplicate ranks across different tranches, gaps in rank sequence, or missing ranks — these cause the waterfall to pay tranches in wrong order
3. OC/IC trigger class names that do not match ANY tranche class name (even after removing "Class" prefix and whitespace) — unmatched triggers are silently disabled in the projection
4. Tranches missing snapshots: if a tranche is defined but has no corresponding snapshot, the model falls back to originalBalance which may be stale
5. Zero spread (spreadBps=0 or NULL) on a rated floating-rate tranche (not an income note) — the model cannot calculate interest due
6. Cross-reference PPM coverage test trigger LEVELS against compliance test trigger LEVELS for the same class — only flag if the numeric values disagree
7. Missing compliance test data entirely (no OC or IC tests at all)
8. Deal currency, collateral currency, and tranche payment frequency: deterministic model blockers are rendered elsewhere in the app. Use deterministicWarnings only to avoid contradicting those blockers; do NOT repeat them as AI warnings.
9. Pool-level currency concentration evidence: if concentration tests or pool-summary currency fields indicate non-deal-currency exposure but loan currencies do not identify it, flag that loan-level currency data needs review only when it is not already covered by deterministicWarnings.

Output a JSON array of warnings. Each warning must have:
- "severity": "error" (blocking — model can't run), "warning" (model runs but may be wrong), or "info" (FYI)
- "message": brief description of the issue
- "action": what the user should do to fix it

Only output the JSON array, nothing else. If no issues found, output an empty array [].
Keep it concise — at most 5-6 warnings for the most important issues.`;

  if (request.signal.aborted) return new Response(null, { status: 204 });
  const authoritativeContext = reportContextRow
    ? await buildServerDealContext(reportContextRow)
    : contextRecord;
  if (request.signal.aborted) return new Response(null, { status: 204 });
  const contextSummary = summarizeDealContext(authoritativeContext);

  let anthropicResponse: Response;
  try {
    anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2048,
        system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: `Analyze this CLO deal data for quality issues:\n\n${contextSummary}` }],
        stream: true,
      }),
      signal: request.signal,
    });
  } catch (err) {
    if (request.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
      return new Response(null, { status: 204 });
    }
    throw err;
  }

  if (!anthropicResponse.ok) {
    const errorText = await anthropicResponse.text();
    return NextResponse.json(
      { error: "API error", details: errorText },
      { status: anthropicResponse.status }
    );
  }

  const reader = anthropicResponse.body?.getReader();
  if (!reader) {
    return NextResponse.json({ error: "No response stream" }, { status: 500 });
  }

  const encoder = new TextEncoder();
  let cancelled = false;

  const stream = new ReadableStream({
    async start(controller) {
      const close = () => {
        try {
          controller.close();
        } catch {
          // stream already closed/cancelled
        }
      };
      const abort = () => {
        cancelled = true;
        reader.cancel().catch(() => {});
      };
      request.signal.addEventListener("abort", abort);
      try {
        await processAnthropicStream(reader, controller, encoder);
        if (!cancelled) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`));
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : "Data quality stream failed";
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", message })}\n\n`));
        }
      } finally {
        request.signal.removeEventListener("abort", abort);
        close();
      }
    },
    cancel() {
      cancelled = true;
      reader.cancel().catch(() => {});
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function dateString(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function buildServerDealContext(row: ReportContextRow): Promise<Record<string, unknown>> {
  const constraints = (row.extracted_constraints || {}) as ExtractedConstraints;
  const reportPeriodId = row.id;
  const maturityDate = dateString(row.stated_maturity_date) ?? constraints.keyDates?.maturityDate ?? null;
  const reinvestmentPeriodEnd =
    dateString(row.reinvestment_period_end) ?? constraints.keyDates?.reinvestmentPeriodEnd ?? null;
  const reportDate = dateString(row.report_date);
  const dealName = row.deal_name ?? constraints.dealIdentity?.dealName ?? null;

  const [
    tranches,
    trancheSnapshots,
    periodData,
    accountBalances,
    parValueAdjustments,
    holdings,
    accruals,
    intexPositions,
  ] = await Promise.all([
    getTranches(row.deal_id),
    getTrancheSnapshots(reportPeriodId),
    getReportPeriodData(reportPeriodId),
    getAccountBalances(reportPeriodId),
    getParValueAdjustments(reportPeriodId),
    getHoldings(reportPeriodId),
    getAccruals(reportPeriodId),
    getIntexPositionsByReportPeriod(reportPeriodId),
  ]);

  const { resolved, warnings: resolutionWarnings } = resolveWaterfallInputs(
    constraints,
    periodData
      ? {
          poolSummary: periodData.poolSummary,
          complianceTests: periodData.complianceTests,
          concentrations: periodData.concentrations,
        }
      : null,
    tranches,
    trancheSnapshots,
    holdings,
    {
      maturity: maturityDate,
      reinvestmentPeriodEnd,
      reportDate,
      dealCurrency: row.deal_currency,
    },
    accountBalances,
    parValueAdjustments,
    intexPositions,
    accruals,
  );

  return {
    reportPeriodId,
    dealName,
    dealCurrency: resolved.currency,
    maturityDate,
    reinvestmentPeriodEnd,
    poolSummary: periodData?.poolSummary ?? null,
    complianceTests: periodData?.complianceTests ?? [],
    concentrationTests: resolved.concentrationTests,
    tranches,
    resolvedTranches: resolved.tranches.map((t) => ({
      className: t.className,
      paymentFrequency: t.paymentFrequency ?? null,
      isIncomeNote: t.isIncomeNote,
      spreadBps: t.spreadBps,
      isFloating: t.isFloating,
    })),
    trancheSnapshots,
    accountBalances,
    collateralCurrencySummary: {
      totalLoans: resolved.loans.length,
      missingCurrencyCount: resolved.loans.filter((loan) => loan.parBalance > 0 && !loan.currency).length,
      currencies: Array.from(new Set(resolved.loans.map((loan) => loan.currency).filter(Boolean))).sort(),
    },
    assetInterestScheduleSummary: {
      totalLoans: resolved.loans.length,
      scheduledLoans: resolved.loans.filter((loan) =>
        loan.assetPaymentIntervalMonths != null && loan.nextPaymentDate != null
      ).length,
      scheduleEvidenceWithoutActiveSchedule: resolved.loans.filter((loan) =>
        loan.assetPaymentPeriodRaw != null &&
        (loan.assetPaymentIntervalMonths == null || loan.nextPaymentDate == null)
      ).length,
      scheduleSources: {
        holding: resolved.loans.filter((loan) => loan.assetPaymentScheduleSource === "holding").length,
        accrual: resolved.loans.filter((loan) => loan.assetPaymentScheduleSource === "accrual").length,
      },
      warnings: resolutionWarnings
        .filter((w) => w.field === "loans.assetPaymentSchedule")
        .map((w) => ({ severity: w.severity, blocking: w.blocking, message: w.message })),
      sampleScheduledLoans: resolved.loans
        .filter((loan) => loan.assetPaymentPeriodRaw != null || loan.nextPaymentDate != null)
        .slice(0, 12)
        .map((loan) => ({
          obligorName: loan.obligorName ?? null,
          assetPaymentPeriodRaw: loan.assetPaymentPeriodRaw ?? null,
          assetPaymentIntervalMonths: loan.assetPaymentIntervalMonths ?? null,
          assetPaymentScheduleSource: loan.assetPaymentScheduleSource ?? null,
          nextPaymentDate: loan.nextPaymentDate ?? null,
          accrualBeginDate: loan.accrualBeginDate ?? null,
          accrualEndDate: loan.accrualEndDate ?? null,
          openingAccruedInterest: loan.openingAccruedInterest ?? null,
        })),
    },
    deterministicWarnings: resolutionWarnings,
    constraints,
    reportDate,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function summarizeDealContext(ctx: Record<string, any>): string {
  const parts: string[] = [];

  parts.push(`Deal: ${ctx.dealName ?? "UNKNOWN"}`);
  parts.push(`Report Date: ${ctx.reportDate ?? "MISSING"}`);
  parts.push(`Maturity Date: ${ctx.maturityDate ?? "MISSING"}`);
  parts.push(`Reinvestment Period End: ${ctx.reinvestmentPeriodEnd ?? "MISSING"}`);
  parts.push(`Deal Currency: ${ctx.dealCurrency ?? "MISSING"}`);

  const deterministicWarnings = ctx.deterministicWarnings as any[] | undefined;
  if (deterministicWarnings && deterministicWarnings.length > 0) {
    parts.push(`\nDeterministic Projection Warnings (${deterministicWarnings.length}):`);
    for (const w of deterministicWarnings) {
      parts.push(`  ${w.severity ?? "warning"}${w.blocking ? " BLOCKING" : ""} ${w.field ?? "unknown"}: ${w.message ?? ""}`);
    }
  }

  const collateralCurrencySummary = ctx.collateralCurrencySummary as Record<string, unknown> | undefined;
  if (collateralCurrencySummary) {
    parts.push(`\nCollateral Currency Summary: ${JSON.stringify(collateralCurrencySummary)}`);
  }

  const concentrationTests = ctx.concentrationTests as any[] | undefined;
  if (concentrationTests && concentrationTests.length > 0) {
    const currencyRows = concentrationTests.filter((c) =>
      /currenc|denominat|eur|gbp|usd|non.?base/i.test(`${c.concentrationType ?? ""} ${c.bucketName ?? ""}`)
    );
    const rowsToShow = currencyRows.length > 0 ? currencyRows : concentrationTests.slice(0, 12);
    parts.push(`\nConcentration Tests (${concentrationTests.length}${currencyRows.length > 0 ? `, ${currencyRows.length} currency-related` : ""}):`);
    for (const c of rowsToShow.slice(0, 12)) {
      parts.push(
        `  ${c.concentrationType ?? "?"} / ${c.bucketName ?? "?"}: actualPct=${c.actualPct ?? "NULL"}, limitPct=${c.limitPct ?? "NULL"}, passing=${c.isPassing ?? "NULL"}`
      );
    }
  }

  const assetInterestScheduleSummary = ctx.assetInterestScheduleSummary as Record<string, unknown> | undefined;
  if (assetInterestScheduleSummary) {
    parts.push(`\nAsset Interest Schedule Summary: ${JSON.stringify(assetInterestScheduleSummary)}`);
  }

  const resolvedTranches = ctx.resolvedTranches as any[] | undefined;
  if (resolvedTranches && resolvedTranches.length > 0) {
    parts.push(`\nResolved Tranche Payment Frequencies (${resolvedTranches.length}):`);
    for (const t of resolvedTranches) {
      parts.push(`  ${t.className ?? "?"}: paymentFrequency=${t.paymentFrequency ?? "MISSING"}, incomeNote=${t.isIncomeNote ?? "?"}, floating=${t.isFloating ?? "?"}, spread=${t.spreadBps ?? "NULL"}bps`);
    }
  }

  // Pool summary — list non-null fields
  const pool = ctx.poolSummary;
  if (pool) {
    const populated = Object.entries(pool).filter(([, v]) => v != null);
    if (populated.length === 0) {
      parts.push("\nPool Summary: ALL FIELDS NULL");
    } else {
      parts.push(`\nPool Summary (${populated.length} fields populated):`);
      for (const [k, v] of populated) {
        parts.push(`  ${k}: ${v}`);
      }
    }
  } else {
    parts.push("\nPool Summary: MISSING (no report period data)");
  }

  // Tranches — compact summary
  const tranches = ctx.tranches as any[] | undefined;
  const trancheById = new Map<string, any>();
  if (tranches && tranches.length > 0) {
    parts.push(`\nTranches (${tranches.length}):`);
    for (const t of tranches) {
      trancheById.set(t.id, t);
      parts.push(`  ${t.className ?? "?"}: balance=${t.originalBalance ?? "NULL"}, spread=${t.spreadBps ?? "NULL"}bps, floating=${t.isFloating ?? "?"}, rank=${t.seniorityRank ?? "?"}, isIncomeNote=${t.isIncomeNote ?? "?"}`);
    }
  } else {
    parts.push("\nTranches: NONE");
  }

  // Tranche snapshots
  const snaps = ctx.trancheSnapshots as any[] | undefined;
  const tranchesWithSnapshots = new Set<string>();
  if (snaps && snaps.length > 0) {
    parts.push(`\nTranche Snapshots (${snaps.length}):`);
    for (const s of snaps) {
      const tranche = trancheById.get(s.trancheId);
      const trancheName = tranche?.className ?? s.trancheId ?? "?";
      tranchesWithSnapshots.add(normalizeClassName(trancheName));
      const bal = s.currentBalance ?? s.beginningBalance;
      const origBal = tranche?.originalBalance;
      const amortNote = origBal != null && bal != null && bal < origBal ? " (normal paydown from original)" : "";
      parts.push(`  ${trancheName}: curBal=${s.currentBalance ?? "NULL"}, beginBal=${s.beginningBalance ?? "NULL"}, endBal=${s.endingBalance ?? "NULL"}, intPaid=${s.interestPaid ?? "NULL"}, princPaid=${s.principalPaid ?? "NULL"}${amortNote}`);
    }
  } else {
    parts.push("\nTranche Snapshots: NONE");
  }

  // Flag tranches missing snapshots
  if (tranches && tranches.length > 0) {
    const missing = tranches.filter((t: any) => !tranchesWithSnapshots.has(normalizeClassName(t.className)));
    if (missing.length > 0) {
      parts.push(`\nTranches WITHOUT snapshots: ${missing.map((t: any) => t.className).join(", ")}`);
    }
  }

  // Compliance tests — compact
  const tests = ctx.complianceTests as any[] | undefined;
  if (tests && tests.length > 0) {
    parts.push(`\nCompliance Tests (${tests.length}):`);
    for (const t of tests) {
      parts.push(`  ${t.testName}${t.testClass ? ` (${t.testClass})` : ""}: actual=${t.actualValue ?? "NULL"}, trigger=${t.triggerLevel ?? "NULL"}, passing=${t.isPassing ?? "NULL"}`);
    }
  } else {
    parts.push("\nCompliance Tests: NONE");
  }

  // Account balances
  const accts = ctx.accountBalances as any[] | undefined;
  if (accts && accts.length > 0) {
    parts.push(`\nAccount Balances (${accts.length}):`);
    for (const a of accts) {
      parts.push(`  ${a.accountName}: ${a.balanceAmount ?? "NULL"} ${a.currency ?? ""}`);
    }
  } else {
    parts.push("\nAccount Balances: NONE");
  }

  // Key constraints from PPM
  const c = ctx.constraints;
  if (c) {
    if (c.keyDates) parts.push(`\nPPM Key Dates: ${JSON.stringify(c.keyDates)}`);
    if (c.capitalStructure && Array.isArray(c.capitalStructure)) {
      parts.push(`\nPPM Capital Structure (${c.capitalStructure.length} tranches):`);
      for (const t of c.capitalStructure) {
        parts.push(`  ${t.class ?? "?"}: principal=${t.principalAmount ?? "NULL"}, spread=${t.spread ?? t.spreadBps ?? "NULL"}, rate=${t.rateType ?? "?"}, maturity=${t.maturityDate ?? "NULL"}`);
      }
    }
    if (c.coverageTestEntries) {
      parts.push(`\nPPM Coverage Tests:`);
      for (const entry of Array.isArray(c.coverageTestEntries) ? c.coverageTestEntries : []) {
        const triggers = [];
        if (entry.parValueRatio) triggers.push(`OC_PAR=${entry.parValueRatio}`);
        if (entry.interestCoverageRatio) triggers.push(`IC=${entry.interestCoverageRatio}`);
        if (triggers.length) parts.push(`  ${entry.class ?? "?"}: ${triggers.join(", ")}`);
      }
    }
  }

  return parts.join("\n");
}
