import { query } from "../../db";
import type { CloDocument } from "../types";
import { callAnthropicChunkedWithTool, normalizeClassName } from "../api";
import { pass1Schema, pass2Schema, pass3Schema, pass4Schema, pass5Schema } from "./schemas";
import { pass1Prompt, pass2Prompt, pass3Prompt, pass4Prompt, pass5Prompt, pass2RepairPrompt, passContinuationPrompt } from "./prompts";
import { normalizePass1, normalizePass2, normalizePass3, normalizePass4, normalizePass5 } from "./normalizer";
import { validateExtraction } from "./validator";
import { zodToJsonSchema } from "zod-to-json-schema";

// zodToJsonSchema v3 doesn't support zod v4 — produces empty schemas.
// This converts zod v4 schemas to JSON Schema for the Anthropic tool API.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function zodToToolSchema(schema: any): Record<string, unknown> {
  const result = zodToJsonSchema(schema as Parameters<typeof zodToJsonSchema>[0], { target: "jsonSchema7" }) as Record<string, unknown>;
  if (result.type === "object" && result.properties) {
    delete result.$schema;
    return result;
  }
  return zodV4ToJsonSchema(schema);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function zodV4ToJsonSchema(schema: any): Record<string, unknown> {
  const def = schema?._def;
  if (!def) return { type: "object" };

  // Zod v4 uses _def.type instead of _def.typeName
  const t = def.type;

  if (t === "object") {
    const shape = def.shape || {};
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, val] of Object.entries(shape)) {
      properties[key] = zodV4ToJsonSchema(val);
      const valType = (val as any)?._def?.type;
      if (valType !== "optional") {
        required.push(key);
      }
    }
    const result: Record<string, unknown> = { type: "object", properties };
    if (required.length > 0) result.required = required;
    return result;
  }
  if (t === "string") return { type: "string" };
  if (t === "number") return { type: "number" };
  if (t === "boolean") return { type: "boolean" };
  if (t === "array") return { type: "array", items: zodV4ToJsonSchema(def.element) };
  if (t === "enum") {
    // Zod v4 enum: _def.entries is { a: "a", b: "b" }
    return { type: "string", enum: Object.values(def.entries) };
  }
  if (t === "nullable") {
    const inner = zodV4ToJsonSchema(def.innerType);
    return { ...inner, nullable: true };
  }
  if (t === "optional") return zodV4ToJsonSchema(def.innerType);
  if (t === "default") return zodV4ToJsonSchema(def.innerType);
  if (t === "unknown" || t === "any") return {};
  if (t === "record") return { type: "object", additionalProperties: zodV4ToJsonSchema(def.valueType) };
  if (t === "union" || t === "discriminatedUnion") {
    const options = (def.options || []).map(zodV4ToJsonSchema);
    return { anyOf: options };
  }
  return {};
}

async function callClaudeStructured(
  apiKey: string,
  system: string,
  documents: CloDocument[],
  userText: string,
  maxTokens: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: any,
  toolName: string,
): Promise<{ data: Record<string, unknown> | null; truncated: boolean; error?: string; status?: number }> {
  const inputSchema = zodToToolSchema(schema);

  const tool = {
    name: toolName,
    description: "Extract structured data from the document. Return all fields matching the schema.",
    inputSchema,
  };

  const chunked = await callAnthropicChunkedWithTool(apiKey, system, documents, userText, maxTokens, tool);

  if (chunked.error) {
    return { data: null, truncated: false, error: chunked.error, status: chunked.status };
  }

  if (chunked.results.length === 1) {
    return { data: chunked.results[0].data, truncated: chunked.results[0].truncated };
  }

  // Multi-chunk: merge structured results
  let merged: Record<string, unknown> = {};
  for (const result of chunked.results) {
    if (!result.data) continue;
    if (Object.keys(merged).length === 0) {
      merged = result.data;
    } else {
      for (const [key, val] of Object.entries(result.data)) {
        if (val == null) continue;
        const baseVal = merged[key];
        if (Array.isArray(val) && Array.isArray(baseVal)) {
          merged[key] = [...baseVal, ...val];
        } else if (merged[key] == null) {
          merged[key] = val;
        }
      }
    }
  }

  const anyTruncated = chunked.results.some((r) => r.truncated);
  return { data: merged, truncated: anyTruncated };
}

async function batchInsert(table: string, rows: Record<string, unknown>[]): Promise<void> {
  if (rows.length === 0) return;

  const columns = Object.keys(rows[0]);
  const valuePlaceholders: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  for (const row of rows) {
    const rowPlaceholders: string[] = [];
    for (const col of columns) {
      rowPlaceholders.push(`$${paramIdx++}`);
      values.push(row[col] ?? null);
    }
    valuePlaceholders.push(`(${rowPlaceholders.join(", ")})`);
  }

  const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${valuePlaceholders.join(", ")}`;
  await query(sql, values);
}

async function getOrCreateDeal(profileId: string): Promise<string> {
  const existing = await query<{ id: string }>(
    "SELECT id FROM clo_deals WHERE profile_id = $1",
    [profileId],
  );
  if (existing.length > 0) return existing[0].id;

  const profiles = await query<{ extracted_constraints: Record<string, unknown> }>(
    "SELECT extracted_constraints FROM clo_profiles WHERE id = $1",
    [profileId],
  );
  const constraints = profiles[0]?.extracted_constraints || {};
  const dealIdentity = (constraints.dealIdentity || {}) as Record<string, unknown>;

  const dealName = (dealIdentity.dealName as string) || (constraints.dealIdentity as Record<string, unknown>)?.dealName as string || null;
  const collateralManager = (constraints.collateralManager as string) || (constraints.cmDetails as Record<string, unknown>)?.name as string || null;

  const rows = await query<{ id: string }>(
    `INSERT INTO clo_deals (profile_id, deal_name, collateral_manager)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [profileId, dealName, collateralManager],
  );
  return rows[0].id;
}

interface PassResult {
  pass: number;
  data: Record<string, unknown> | null;
  truncated: boolean;
  error?: string;
  raw: string;
}

interface RepairAction {
  pass: number;
  reason: string;
  type: "validation_mismatch" | "truncation";
}

function detectRepairNeeds(
  pass1Data: import("./schemas").Pass1Output,
  passResults: PassResult[],
): RepairAction[] {
  const repairs: RepairAction[] = [];

  // Check for truncated passes
  for (const pr of passResults) {
    if (pr.truncated && pr.data) {
      repairs.push({
        pass: pr.pass,
        reason: `Pass ${pr.pass} output was truncated`,
        type: "truncation",
      });
    }
  }

  // Check validation: holdings count mismatch (Pass 2)
  const p2 = passResults.find((p) => p.pass === 2);
  if (p2?.data) {
    const holdings = (p2.data as unknown as import("./schemas").Pass2Output).holdings;
    const expectedAssets = pass1Data.poolSummary.numberOfAssets;
    if (expectedAssets != null && holdings.length < expectedAssets * 0.85) {
      repairs.push({
        pass: 2,
        reason: `Extracted ${holdings.length} holdings but pool summary says ${expectedAssets} assets`,
        type: "validation_mismatch",
      });
    }
  }

  // Deduplicate — if a pass has both truncation and validation issues, keep validation (more targeted)
  const seen = new Set<number>();
  return repairs.filter((r) => {
    if (seen.has(r.pass)) return false;
    seen.add(r.pass);
    return true;
  });
}

/** Get the last N items from the largest array in a pass result, for continuation context */
function getLastItems(data: Record<string, unknown>, n: number): { field: string; items: string[] } {
  let largestField = "";
  let largestArray: unknown[] = [];

  for (const [key, val] of Object.entries(data)) {
    if (Array.isArray(val) && val.length > largestArray.length) {
      largestField = key;
      largestArray = val;
    }
  }

  if (largestArray.length === 0) return { field: "", items: [] };

  const last = largestArray.slice(-n);
  const items = last.map((item) => {
    if (typeof item === "object" && item !== null) {
      const obj = item as Record<string, unknown>;
      const name = obj.obligorName ?? obj.testName ?? obj.description ?? obj.className ?? obj.bucketName ?? obj.feeType ?? "";
      return String(name);
    }
    return String(item);
  });

  return { field: largestField, items };
}

export async function runExtraction(
  profileId: string,
  apiKey: string,
  documents: CloDocument[],
): Promise<{ reportPeriodId: string; status: "complete" | "partial" | "error" }> {
  const dealId = await getOrCreateDeal(profileId);

  // Pass 1: blocking — we need reportDate before anything else
  const p1Prompt = pass1Prompt();
  const p1Result = await callClaudeStructured(apiKey, p1Prompt.system, documents, p1Prompt.user, 65536, pass1Schema, "extract_pass1");

  if (p1Result.error) {
    throw new Error(`Pass 1 API error: ${p1Result.error}`);
  }

  let pass1Data;
  try {
    pass1Data = pass1Schema.parse(p1Result.data);
  } catch (e) {
    throw new Error(`Pass 1 validate error: ${(e as Error).message}`);
  }

  const reportDate = pass1Data.reportMetadata.reportDate;
  const rawOutputs: Record<string, unknown> = { pass1: p1Result.data };

  // Create report period
  const rpRows = await query<{ id: string }>(
    `INSERT INTO clo_report_periods (deal_id, report_date, payment_date, previous_payment_date, report_type, report_source, reporting_period_start, reporting_period_end, extraction_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'extracting')
     ON CONFLICT (deal_id, report_date) DO UPDATE SET extraction_status = 'extracting', updated_at = now()
     RETURNING id`,
    [
      dealId,
      reportDate,
      pass1Data.reportMetadata.paymentDate ?? null,
      pass1Data.reportMetadata.previousPaymentDate ?? null,
      pass1Data.reportMetadata.reportType ?? null,
      pass1Data.reportMetadata.reportSource ?? null,
      pass1Data.reportMetadata.reportingPeriodStart ?? null,
      pass1Data.reportMetadata.reportingPeriodEnd ?? null,
    ],
  );
  const reportPeriodId = rpRows[0].id;

  // Helper: delete old data only when we have new data to replace it
  async function replaceIfPresent(table: string, rows: Record<string, unknown>[]) {
    if (rows.length === 0) return;
    await query(`DELETE FROM ${table} WHERE report_period_id = $1`, [reportPeriodId]);
    await batchInsert(table, rows);
  }

  // Insert Pass 1 data (only replace tables where we have new data)
  const p1Normalized = normalizePass1(pass1Data, reportPeriodId);
  await replaceIfPresent("clo_pool_summary", [p1Normalized.poolSummary]);
  await replaceIfPresent("clo_compliance_tests", p1Normalized.complianceTests);
  await replaceIfPresent("clo_account_balances", p1Normalized.accountBalances);
  await replaceIfPresent("clo_par_value_adjustments", p1Normalized.parValueAdjustments);

  // Passes 2-5 in parallel
  const passResults: PassResult[] = [];
  const overflowRows: Record<string, unknown>[] = [];

  // Collect Pass 1 overflow
  if (pass1Data._overflow && pass1Data._overflow.length > 0) {
    for (const item of pass1Data._overflow) {
      overflowRows.push({
        report_period_id: reportPeriodId,
        extraction_pass: 1,
        source_section: "pass1",
        label: item.label,
        content: JSON.stringify(item.content),
      });
    }
  }

  const [p2Result, p3Result, p4Result, p5Result] = await Promise.all([
    callClaudeStructured(apiKey, pass2Prompt(reportDate).system, documents, pass2Prompt(reportDate).user, 65536, pass2Schema, "extract_pass2"),
    callClaudeStructured(apiKey, pass3Prompt(reportDate).system, documents, pass3Prompt(reportDate).user, 65536, pass3Schema, "extract_pass3"),
    callClaudeStructured(apiKey, pass4Prompt(reportDate).system, documents, pass4Prompt(reportDate).user, 65536, pass4Schema, "extract_pass4"),
    callClaudeStructured(apiKey, pass5Prompt(reportDate).system, documents, pass5Prompt(reportDate).user, 65536, pass5Schema, "extract_pass5"),
  ]);

  const passInputs = [
    { num: 2, result: p2Result, schema: pass2Schema },
    { num: 3, result: p3Result, schema: pass3Schema },
    { num: 4, result: p4Result, schema: pass4Schema },
    { num: 5, result: p5Result, schema: pass5Schema },
  ];

  for (const { num, result, schema } of passInputs) {
    rawOutputs[`pass${num}`] = result.data;
    if (result.error) {
      passResults.push({ pass: num, data: null, truncated: false, error: result.error, raw: JSON.stringify(result.data) });
      continue;
    }
    try {
      const validated = schema.parse(result.data);
      passResults.push({ pass: num, data: validated as Record<string, unknown>, truncated: result.truncated, raw: JSON.stringify(result.data) });

      // Collect overflow
      const overflow = (validated as Record<string, unknown[]>)._overflow;
      if (Array.isArray(overflow) && overflow.length > 0) {
        for (const item of overflow as Array<{ label: string; content: unknown }>) {
          overflowRows.push({
            report_period_id: reportPeriodId,
            extraction_pass: num,
            source_section: `pass${num}`,
            label: item.label,
            content: JSON.stringify(item.content),
          });
        }
      }
    } catch (e) {
      passResults.push({ pass: num, data: null, truncated: result.truncated, error: (e as Error).message, raw: JSON.stringify(result.data) });
    }
  }

  // Insert Pass 2 data (holdings)
  const p2 = passResults.find((p) => p.pass === 2);
  if (p2?.data) {
    const normalized = normalizePass2(p2.data as unknown as import("./schemas").Pass2Output, reportPeriodId);
    await replaceIfPresent("clo_holdings", normalized.holdings);
  }

  // Insert Pass 3 data (concentrations)
  const p3 = passResults.find((p) => p.pass === 3);
  if (p3?.data) {
    const normalized = normalizePass3(p3.data as unknown as import("./schemas").Pass3Output, reportPeriodId);
    await replaceIfPresent("clo_concentrations", normalized.concentrations);
  }

  // Insert Pass 4 data (waterfall, proceeds, trades, trading_summary, tranche_snapshots)
  const p4 = passResults.find((p) => p.pass === 4);
  if (p4?.data) {
    const normalized = normalizePass4(p4.data as unknown as import("./schemas").Pass4Output, reportPeriodId);

    await replaceIfPresent("clo_waterfall_steps", normalized.waterfallSteps);
    await replaceIfPresent("clo_proceeds", normalized.proceeds);
    await replaceIfPresent("clo_trades", normalized.trades);
    if (normalized.tradingSummary) {
      await query("DELETE FROM clo_trading_summary WHERE report_period_id = $1", [reportPeriodId]);
      await batchInsert("clo_trading_summary", [normalized.tradingSummary]);
    }

    // Tranche snapshots need tranche_id lookup (normalized match)
    if (normalized.trancheSnapshots.length > 0) {
      await query("DELETE FROM clo_tranche_snapshots WHERE report_period_id = $1", [reportPeriodId]);
      for (const snapshot of normalized.trancheSnapshots) {
        const normalizedName = normalizeClassName(snapshot.className);
        const allTranches = await query<{ id: string; class_name: string }>(
          "SELECT id, class_name FROM clo_tranches WHERE deal_id = $1",
          [dealId],
        );
        let existing = allTranches.filter((t) => normalizeClassName(t.class_name) === normalizedName);

        if (existing.length === 0) {
          existing = await query<{ id: string; class_name: string }>(
            `INSERT INTO clo_tranches (deal_id, class_name) VALUES ($1, $2) RETURNING id, class_name`,
            [dealId, snapshot.className],
          );
        }

        await batchInsert("clo_tranche_snapshots", [{ tranche_id: existing[0].id, ...snapshot.data }]);

        // Enrich the tranche record with financial data from the snapshot
        const bal = snapshot.data.current_balance ?? snapshot.data.beginning_balance;
        const rate = snapshot.data.coupon_rate;
        if (bal != null || rate != null) {
          const setClauses: string[] = [];
          const setValues: unknown[] = [];
          let pi = 1;
          if (bal != null) { setClauses.push(`original_balance = $${pi++}`); setValues.push(bal); }
          // Store coupon rate as spread_bps (rate * 100 to convert % to bps)
          if (rate != null) { setClauses.push(`spread_bps = $${pi++}`); setValues.push(Number(rate) * 100); }
          if (setClauses.length > 0) {
            setValues.push(existing[0].id);
            await query(
              `UPDATE clo_tranches SET ${setClauses.join(", ")} WHERE id = $${pi}`,
              setValues,
            );
          }
        }
      }

      // Infer maturity date from tranche names (e.g., "due 2035" → parse from full name)
      const maturityDates: string[] = [];
      for (const s of normalized.trancheSnapshots) {
        const m = s.className.match(/due\s+(\d{4})/i);
        if (m) maturityDates.push(m[1]);
      }
      if (maturityDates.length > 0) {
        const maxYear = Math.max(...maturityDates.map(Number));
        // Update deal with inferred maturity if not already set properly
        await query(
          `UPDATE clo_deals SET stated_maturity_date = COALESCE(
            CASE WHEN stated_maturity_date IS NOT NULL AND stated_maturity_date ~ '\\d{4}-\\d{2}-\\d{2}' THEN stated_maturity_date ELSE NULL END,
            $1
          ) WHERE id = $2`,
          [`${maxYear}-07-15`, dealId],
        );
      }
    }
  }

  // Insert Pass 5 data (supplementary + events)
  const p5 = passResults.find((p) => p.pass === 5);
  let supplementaryData: Record<string, unknown> | null = null;
  if (p5?.data) {
    const normalized = normalizePass5(p5.data as unknown as import("./schemas").Pass5Output, reportPeriodId, dealId);
    supplementaryData = normalized.supplementaryData;

    if (normalized.events.length > 0) {
      await query("DELETE FROM clo_events WHERE report_period_id = $1", [reportPeriodId]);
      await batchInsert("clo_events", normalized.events);
    }
  }

  // Insert overflow (always replace — overflow is cumulative from all passes)
  if (overflowRows.length > 0) {
    await query("DELETE FROM clo_extraction_overflow WHERE report_period_id = $1", [reportPeriodId]);
    await batchInsert("clo_extraction_overflow", overflowRows);
  }

  // Run cross-validation
  const pass2Data = p2?.data as unknown as import("./schemas").Pass2Output | null;
  const pass3Data = p3?.data as unknown as import("./schemas").Pass3Output | null;
  let validationResult = validateExtraction(pass1Data, pass2Data ?? null, pass3Data ?? null);

  // ─── Repair Loop: re-extract passes with validation failures or truncation ───
  const repairNeeds = detectRepairNeeds(pass1Data, passResults);

  if (repairNeeds.length > 0) {
    console.log(`[extraction] Repair needed for ${repairNeeds.length} pass(es): ${repairNeeds.map((r) => `Pass ${r.pass} (${r.reason})`).join(", ")}`);

    for (const repair of repairNeeds) {
      const pr = passResults.find((p) => p.pass === repair.pass);

      if (repair.type === "truncation" && pr?.data) {
        const { field, items } = getLastItems(pr.data as Record<string, unknown>, 3);
        if (field && items.length > 0) {
          const contPrompt = passContinuationPrompt(repair.pass, reportDate, items, field);
          const schema = repair.pass === 2 ? pass2Schema : repair.pass === 3 ? pass3Schema : repair.pass === 4 ? pass4Schema : pass5Schema;

          console.log(`[extraction] Running continuation for Pass ${repair.pass}, last items: ${items.join(", ")}`);
          const contResult = await callClaudeStructured(apiKey, contPrompt.system, documents, contPrompt.user, 65536, schema, `extract_pass${repair.pass}`);

          if (contResult.data && !contResult.error) {
            const existing = pr.data as Record<string, unknown>;
            for (const [key, val] of Object.entries(contResult.data as Record<string, unknown>)) {
              if (val == null) continue;
              const baseVal = existing[key];
              if (Array.isArray(val) && Array.isArray(baseVal)) {
                existing[key] = [...baseVal, ...val];
              } else if (existing[key] == null) {
                existing[key] = val;
              }
            }
            pr.truncated = contResult.truncated;
            rawOutputs[`pass${repair.pass}_continuation`] = contResult.data;

            // Re-insert merged data
            if (repair.pass === 2) {
              try {
                const validated = pass2Schema.parse(existing);
                const normalized = normalizePass2(validated, reportPeriodId);
                await replaceIfPresent("clo_holdings", normalized.holdings);
              } catch { /* keep original */ }
            } else if (repair.pass === 3) {
              try {
                const validated = pass3Schema.parse(existing);
                const normalized = normalizePass3(validated, reportPeriodId);
                await replaceIfPresent("clo_concentrations", normalized.concentrations);
              } catch { /* keep original */ }
            } else if (repair.pass === 4) {
              try {
                const validated = pass4Schema.parse(existing);
                const normalized = normalizePass4(validated, reportPeriodId);
                await replaceIfPresent("clo_waterfall_steps", normalized.waterfallSteps);
                await replaceIfPresent("clo_proceeds", normalized.proceeds);
                await replaceIfPresent("clo_trades", normalized.trades);
              } catch { /* keep original */ }
            }
          }
        }
      } else if (repair.type === "validation_mismatch" && repair.pass === 2) {
        const holdings = pr?.data ? (pr.data as unknown as import("./schemas").Pass2Output).holdings : [];
        const expectedAssets = pass1Data.poolSummary.numberOfAssets ?? 0;
        const repairPr = pass2RepairPrompt(reportDate, holdings.length, expectedAssets);

        console.log(`[extraction] Running repair extraction for Pass 2 (${holdings.length}/${expectedAssets} holdings)`);
        const repairResult = await callClaudeStructured(apiKey, repairPr.system, documents, repairPr.user, 65536, pass2Schema, "extract_pass2");

        if (repairResult.data && !repairResult.error) {
          try {
            const validated = pass2Schema.parse(repairResult.data);
            if (validated.holdings.length > holdings.length) {
              console.log(`[extraction] Repair improved Pass 2: ${holdings.length} → ${validated.holdings.length} holdings`);
              const prIdx = passResults.findIndex((p) => p.pass === 2);
              passResults[prIdx] = {
                pass: 2,
                data: validated as unknown as Record<string, unknown>,
                truncated: repairResult.truncated,
                raw: JSON.stringify(repairResult.data),
              };
              rawOutputs.pass2_repair = repairResult.data;

              const normalized = normalizePass2(validated, reportPeriodId);
              await replaceIfPresent("clo_holdings", normalized.holdings);
            } else {
              console.log(`[extraction] Repair did not improve Pass 2 (${validated.holdings.length} ≤ ${holdings.length}), keeping original`);
            }
          } catch (e) {
            console.log(`[extraction] Repair Pass 2 validation failed: ${(e as Error).message}`);
          }
        }
      }
    }

    // Re-run validation after repairs
    const repairedP2 = passResults.find((p) => p.pass === 2);
    const repairedPass2Data = repairedP2?.data as unknown as import("./schemas").Pass2Output | null;
    const repairedPass3Data = (passResults.find((p) => p.pass === 3)?.data as unknown as import("./schemas").Pass3Output) ?? null;
    validationResult = validateExtraction(pass1Data, repairedPass2Data ?? null, repairedPass3Data);
  }

  // Determine final status (after any repairs)
  const finalFailedPasses = passResults.filter((p) => !p.data);
  const finalTruncatedPasses = passResults.filter((p) => p.truncated);
  const status = finalFailedPasses.length > 0 ? "partial"
    : (p1Result.truncated || finalTruncatedPasses.length > 0) ? "partial"
    : "complete";

  // Update report period with final data
  await query(
    `UPDATE clo_report_periods
     SET extraction_status = $1,
         extracted_at = now(),
         raw_extraction = $2::jsonb,
         supplementary_data = $3::jsonb,
         data_quality = $4::jsonb,
         updated_at = now()
     WHERE id = $5`,
    [
      status,
      JSON.stringify(rawOutputs),
      supplementaryData ? JSON.stringify(supplementaryData) : null,
      JSON.stringify(validationResult),
      reportPeriodId,
    ],
  );

  return { reportPeriodId, status };
}
