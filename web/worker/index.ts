import { config } from "dotenv";
import { Pool } from "pg";
import { decryptApiKey } from "../lib/crypto.js";
import { runPipeline } from "./pipeline.js";
import { getUserGithubToken, buildCodeContext } from "../lib/github.js";
import {
  runCommitteePipeline,
  runEvaluationPipeline,
  runIdeaPipeline,
} from "./ic-pipeline.js";
import {
  runPanelPipeline,
  runAnalysisPipeline,
  runScreeningPipeline,
} from "./clo-pipeline.js";
import { runSectionPpmExtraction } from "../lib/clo/extraction/ppm-extraction.js";
import { syncPpmToRelationalTables } from "../lib/clo/extraction/persist-ppm.js";
import { runExtraction, runSectionExtraction } from "../lib/clo/extraction/runner.js";
import { runPortfolioExtraction } from "../lib/clo/extraction/portfolio-extraction.js";
import { getApiKeyForUser, resetFreeTrial } from "../lib/trial.js";

if (!process.env.DATABASE_URL) {
  config({ path: ".env.local" });
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const POLL_INTERVAL_MS = 5000;

// ─── Daily Briefing ──────────────────────────────────────────────────
const BRIEFING_INTERVAL_MS = 20 * 60 * 60 * 1000; // 20 hours
let lastBriefingFetch = 0;
let isFirstBriefingFetch = true;

async function maybeFetchBriefing() {
  if (!process.env.BRIEF_API_KEY) return;
  const now = Date.now();
  if (now - lastBriefingFetch < BRIEFING_INTERVAL_MS) return;
  lastBriefingFetch = now;

  const forceRefresh = isFirstBriefingFetch;
  isFirstBriefingFetch = false;

  if (forceRefresh) {
    console.log("[worker] First run after deployment — forcing briefing refresh");
  }

  for (const briefType of ["general", "clo"] as const) {
    if (!forceRefresh) {
      const existing = await pool.query(
        "SELECT id FROM daily_briefings WHERE brief_type = $1 AND fetched_at > now() - interval '20 hours' LIMIT 1",
        [briefType]
      );
      if (existing.rows.length > 0) continue;
    }

    console.log(`[worker] Fetching ${briefType} briefing from external API...`);
    const res = await fetch(`https://daily-brief-production-a744.up.railway.app/briefing/${briefType}?id=-1`, {
      headers: { Authorization: `Bearer ${process.env.BRIEF_API_KEY}` },
    });
    if (!res.ok) {
      console.error(`[worker] ${briefType} briefing fetch failed: HTTP ${res.status}`);
      continue;
    }
    const content = await res.text();
    if (!content.trim()) {
      console.error(`[worker] ${briefType} briefing fetch returned empty response`);
      continue;
    }

    await pool.query(
      "INSERT INTO daily_briefings (brief_type, content) VALUES ($1, $2)",
      [briefType, content]
    );
    console.log(`[worker] ${briefType} briefing fetched and stored (${content.length} chars)`);
  }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

async function claimJob(): Promise<{
  id: string;
  topic_input: string;
  user_id: string;
  raw_files: Record<string, string>;
  attachments: Array<{ name: string; type: string; size: number; base64: string; textContent?: string }>;
  slug: string;
  github_repo_owner: string | null;
  github_repo_name: string | null;
  github_repo_branch: string | null;
  saved_character_ids: string[];
  pipeline_options: Record<string, unknown> | null;
} | null> {
  const result = await pool.query(
    `UPDATE assemblies SET status = 'running', current_phase = 'domain-analysis'
     WHERE id = (
       SELECT id FROM assemblies WHERE status = 'queued'
       ORDER BY created_at LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, topic_input, user_id, raw_files, attachments, slug, github_repo_owner, github_repo_name, github_repo_branch, saved_character_ids, pipeline_options`
  );
  return result.rows[0] ?? null;
}

async function getUserApiKey(
  userId: string
): Promise<{ encrypted: Buffer; iv: Buffer }> {
  const result = await pool.query(
    `SELECT encrypted_api_key, api_key_iv FROM users WHERE id = $1`,
    [userId]
  );
  const row = result.rows[0];
  if (!row?.encrypted_api_key || !row?.api_key_iv) {
    throw new Error(`No API key found for user ${userId}`);
  }
  return {
    encrypted: Buffer.from(row.encrypted_api_key),
    iv: Buffer.from(row.api_key_iv),
  };
}

async function processJob(job: {
  id: string;
  topic_input: string;
  user_id: string;
  raw_files: Record<string, string>;
  attachments: Array<{ name: string; type: string; size: number; base64: string; textContent?: string }>;
  slug: string;
  github_repo_owner: string | null;
  github_repo_name: string | null;
  github_repo_branch: string | null;
  saved_character_ids: string[];
  pipeline_options: Record<string, unknown> | null;
}) {
  const { apiKey } = await getApiKeyForUser(job.user_id);
  const slug = job.slug || slugify(job.topic_input);

  if (!job.slug) {
    await pool.query(`UPDATE assemblies SET slug = $1 WHERE id = $2`, [
      slug,
      job.id,
    ]);
  }

  let codeContext: string | undefined;
  if (job.github_repo_owner && job.github_repo_name) {
    try {
      await pool.query(
        `UPDATE assemblies SET current_phase = 'code-analysis' WHERE id = $1`,
        [job.id]
      );
      const githubToken = await getUserGithubToken(job.user_id);
      if (githubToken) {
        codeContext = await buildCodeContext(
          githubToken,
          job.github_repo_owner,
          job.github_repo_name,
          job.github_repo_branch || "main",
          job.topic_input,
          apiKey
        );
        console.log(`[worker] Code context fetched: ${codeContext.length} chars`);
      }
    } catch (err) {
      console.warn("[worker] Failed to fetch code context:", err);
    }
  }

  const attachments = Array.isArray(job.attachments) && job.attachments.length > 0
    ? job.attachments
    : undefined;
  if (attachments) {
    console.log(`[worker] Assembly ${job.id}: ${attachments.length} attachment(s)`);
  }

  let savedCharacters: Array<{
    name: string; tag: string; biography: string; framework: string;
    frameworkName: string; blindSpot: string; heroes: string[];
    rhetoricalTendencies: string; debateStyle: string; avatarUrl?: string;
  }> | undefined;

  const savedIds: string[] = Array.isArray(job.saved_character_ids) ? job.saved_character_ids : [];
  if (savedIds.length > 0) {
    const result = await pool.query(
      `SELECT name, tag, biography, framework, framework_name, blind_spot,
              heroes, rhetorical_tendencies, debate_style, avatar_url
       FROM saved_characters WHERE id = ANY($1)`,
      [savedIds]
    );
    savedCharacters = result.rows.map((r: Record<string, unknown>) => ({
      name: r.name as string,
      tag: r.tag as string,
      biography: r.biography as string,
      framework: r.framework as string,
      frameworkName: r.framework_name as string,
      blindSpot: r.blind_spot as string,
      heroes: (r.heroes || []) as string[],
      rhetoricalTendencies: r.rhetorical_tendencies as string,
      debateStyle: r.debate_style as string,
      avatarUrl: (r.avatar_url || undefined) as string | undefined,
    }));
    console.log(`[worker] Assembly ${job.id}: ${savedCharacters.length} saved character(s)`);
  }

  const pipelineOptions = job.pipeline_options ?? {};

  await runPipeline({
    assemblyId: job.id,
    topic: job.topic_input,
    slug,
    apiKey,
    codeContext,
    attachments,
    savedCharacters,
    initialRawFiles: job.raw_files || {},
    skipVerification: pipelineOptions.skipVerification === true,
    updatePhase: async (phase: string) => {
      await pool.query(
        `UPDATE assemblies SET current_phase = $1 WHERE id = $2`,
        [phase, job.id]
      );
    },
    updateRawFiles: async (files: Record<string, string>) => {
      await pool.query(
        `UPDATE assemblies SET raw_files = $1::jsonb WHERE id = $2`,
        [JSON.stringify(files), job.id]
      );
    },
    updateParsedData: async (data: unknown) => {
      await pool.query(
        `UPDATE assemblies SET parsed_data = $1::jsonb WHERE id = $2`,
        [JSON.stringify(data), job.id]
      );
    },
  });

  await pool.query(
    `UPDATE assemblies SET status = 'complete', completed_at = NOW() WHERE id = $1`,
    [job.id]
  );
  console.log(`[worker] Assembly ${job.id} completed`);
}

// ─── IC Jobs ────────────────────────────────────────────────────────

const IC_ALLOWED_TABLES = new Set(["ic_committees", "ic_evaluations", "ic_ideas"]);

async function handleIcJobError(table: string, jobId: string, userId: string, err: unknown) {
  const message = err instanceof Error ? err.message : "Unknown error";
  console.error(`[worker] IC ${table} ${jobId} failed: ${message}`);
  if (!IC_ALLOWED_TABLES.has(table)) throw new Error(`Invalid table name: ${table}`);
  await pool.query(`UPDATE ${table} SET status = 'error', error_message = $1 WHERE id = $2`, [message, jobId]);
  if (message.includes("Invalid API key")) {
    await pool.query("UPDATE users SET api_key_valid = false WHERE id = $1", [userId]);
  }
}

async function claimCommitteeJob() {
  const result = await pool.query(
    `UPDATE ic_committees SET status = 'generating', updated_at = NOW()
     WHERE id = (
       SELECT c.id FROM ic_committees c
       JOIN investor_profiles p ON c.profile_id = p.id
       WHERE c.status = 'queued'
       ORDER BY c.created_at LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, profile_id,
       (SELECT p.user_id FROM investor_profiles p WHERE p.id = ic_committees.profile_id) as user_id,
       raw_files`
  );
  return result.rows[0] ?? null;
}

async function claimEvaluationJob() {
  const result = await pool.query(
    `UPDATE ic_evaluations SET status = 'running', current_phase = 'opportunity-analysis'
     WHERE id = (
       SELECT e.id FROM ic_evaluations e
       JOIN ic_committees c ON e.committee_id = c.id
       JOIN investor_profiles p ON c.profile_id = p.id
       WHERE e.status = 'queued'
       ORDER BY e.created_at LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, committee_id,
       (SELECT p.user_id FROM investor_profiles p
        JOIN ic_committees c ON c.profile_id = p.id
        WHERE c.id = ic_evaluations.committee_id) as user_id,
       raw_files`
  );
  return result.rows[0] ?? null;
}

async function claimIdeaJob() {
  const result = await pool.query(
    `UPDATE ic_ideas SET status = 'running', current_phase = 'gap-analysis'
     WHERE id = (
       SELECT i.id FROM ic_ideas i
       JOIN ic_committees c ON i.committee_id = c.id
       JOIN investor_profiles p ON c.profile_id = p.id
       WHERE i.status = 'queued'
       ORDER BY i.created_at LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, committee_id,
       (SELECT p.user_id FROM investor_profiles p
        JOIN ic_committees c ON c.profile_id = p.id
        WHERE c.id = ic_ideas.committee_id) as user_id,
       raw_files`
  );
  return result.rows[0] ?? null;
}

async function pollIcJobs() {
  // Committee jobs
  const committeeJob = await claimCommitteeJob();
  if (committeeJob) {
    console.log(`[worker] Claimed IC committee job ${committeeJob.id}`);
    try {
      const { encrypted, iv } = await getUserApiKey(committeeJob.user_id);
      const apiKey = decryptApiKey(encrypted, iv);
      const { members } = await runCommitteePipeline(pool, committeeJob.profile_id, apiKey, committeeJob.raw_files || {}, {
        updatePhase: async (phase) => { console.log(`[worker] IC committee ${committeeJob.id}: ${phase}`); },
        updateRawFiles: async (files) => {
          await pool.query("UPDATE ic_committees SET raw_files = $1::jsonb, updated_at = NOW() WHERE id = $2", [JSON.stringify(files), committeeJob.id]);
        },
        updateParsedData: async (data) => {
          const parsed = data as { members: unknown[] };
          await pool.query("UPDATE ic_committees SET members = $1::jsonb, updated_at = NOW() WHERE id = $2", [JSON.stringify(parsed.members || []), committeeJob.id]);
        },
      });
      await pool.query("UPDATE ic_committees SET status = 'active', members = $1::jsonb, updated_at = NOW() WHERE id = $2", [JSON.stringify(members), committeeJob.id]);
      console.log(`[worker] IC committee ${committeeJob.id} completed with ${members.length} members`);
    } catch (err) {
      await handleIcJobError("ic_committees", committeeJob.id, committeeJob.user_id, err);
    }
  }

  // Evaluation jobs
  const evalJob = await claimEvaluationJob();
  if (evalJob) {
    console.log(`[worker] Claimed IC evaluation job ${evalJob.id}`);
    try {
      const { encrypted, iv } = await getUserApiKey(evalJob.user_id);
      const apiKey = decryptApiKey(encrypted, iv);
      await runEvaluationPipeline(pool, evalJob.id, apiKey, evalJob.raw_files || {}, {
        updatePhase: async (phase) => {
          console.log(`[worker] IC evaluation ${evalJob.id}: ${phase}`);
          await pool.query("UPDATE ic_evaluations SET current_phase = $1 WHERE id = $2", [phase, evalJob.id]);
        },
        updateRawFiles: async (files) => {
          await pool.query("UPDATE ic_evaluations SET raw_files = $1::jsonb WHERE id = $2", [JSON.stringify(files), evalJob.id]);
        },
        updateParsedData: async (data) => {
          await pool.query("UPDATE ic_evaluations SET parsed_data = $1::jsonb WHERE id = $2", [JSON.stringify(data), evalJob.id]);
        },
      });
      await pool.query("UPDATE ic_evaluations SET status = 'complete', completed_at = NOW() WHERE id = $1", [evalJob.id]);
      console.log(`[worker] IC evaluation ${evalJob.id} completed`);
    } catch (err) {
      await handleIcJobError("ic_evaluations", evalJob.id, evalJob.user_id, err);
    }
  }

  // Idea jobs
  const ideaJob = await claimIdeaJob();
  if (ideaJob) {
    console.log(`[worker] Claimed IC idea job ${ideaJob.id}`);
    try {
      const { encrypted, iv } = await getUserApiKey(ideaJob.user_id);
      const apiKey = decryptApiKey(encrypted, iv);
      await runIdeaPipeline(pool, ideaJob.id, apiKey, ideaJob.raw_files || {}, {
        updatePhase: async (phase) => {
          console.log(`[worker] IC idea ${ideaJob.id}: ${phase}`);
          await pool.query("UPDATE ic_ideas SET current_phase = $1 WHERE id = $2", [phase, ideaJob.id]);
        },
        updateRawFiles: async (files) => {
          await pool.query("UPDATE ic_ideas SET raw_files = $1::jsonb WHERE id = $2", [JSON.stringify(files), ideaJob.id]);
        },
        updateParsedData: async (data) => {
          await pool.query("UPDATE ic_ideas SET parsed_data = $1::jsonb WHERE id = $2", [JSON.stringify(data), ideaJob.id]);
        },
      });
      await pool.query("UPDATE ic_ideas SET status = 'complete', completed_at = NOW() WHERE id = $1", [ideaJob.id]);
      console.log(`[worker] IC idea ${ideaJob.id} completed`);
    } catch (err) {
      await handleIcJobError("ic_ideas", ideaJob.id, ideaJob.user_id, err);
    }
  }
}

// ─── CLO Jobs ────────────────────────────────────────────────────────

const CLO_ALLOWED_TABLES = new Set(["clo_panels", "clo_analyses", "clo_screenings"]);

async function handleCloJobError(table: string, jobId: string, userId: string, err: unknown) {
  const message = err instanceof Error ? err.message : "Unknown error";
  console.error(`[worker] CLO ${table} ${jobId} failed: ${message}`);
  if (!CLO_ALLOWED_TABLES.has(table)) throw new Error(`Invalid table name: ${table}`);
  await pool.query(`UPDATE ${table} SET status = 'error', error_message = $1 WHERE id = $2`, [message, jobId]);
  if (message.includes("Invalid API key")) {
    await pool.query("UPDATE users SET api_key_valid = false WHERE id = $1", [userId]);
  }
}

async function claimPanelJob() {
  const result = await pool.query(
    `UPDATE clo_panels SET status = 'generating', updated_at = NOW()
     WHERE id = (
       SELECT p.id FROM clo_panels p
       JOIN clo_profiles pr ON p.profile_id = pr.id
       WHERE p.status = 'queued'
       ORDER BY p.created_at LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, profile_id,
       (SELECT pr.user_id FROM clo_profiles pr WHERE pr.id = clo_panels.profile_id) as user_id,
       raw_files`
  );
  return result.rows[0] ?? null;
}

async function claimAnalysisJob() {
  const result = await pool.query(
    `UPDATE clo_analyses SET status = 'running', current_phase = 'credit-analysis'
     WHERE id = (
       SELECT a.id FROM clo_analyses a
       JOIN clo_panels p ON a.panel_id = p.id
       JOIN clo_profiles pr ON p.profile_id = pr.id
       WHERE a.status = 'queued'
       ORDER BY a.created_at LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, panel_id,
       (SELECT pr.user_id FROM clo_profiles pr
        JOIN clo_panels p ON p.profile_id = pr.id
        WHERE p.id = clo_analyses.panel_id) as user_id,
       raw_files`
  );
  return result.rows[0] ?? null;
}

async function claimScreeningJob() {
  const result = await pool.query(
    `UPDATE clo_screenings SET status = 'running', current_phase = 'gap-analysis'
     WHERE id = (
       SELECT s.id FROM clo_screenings s
       JOIN clo_panels p ON s.panel_id = p.id
       JOIN clo_profiles pr ON p.profile_id = pr.id
       WHERE s.status = 'queued'
       ORDER BY s.created_at LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, panel_id,
       (SELECT pr.user_id FROM clo_profiles pr
        JOIN clo_panels p ON p.profile_id = pr.id
        WHERE p.id = clo_screenings.panel_id) as user_id,
       raw_files`
  );
  return result.rows[0] ?? null;
}

async function pollCloJobs() {
  // Panel jobs
  const panelJob = await claimPanelJob();
  if (panelJob) {
    console.log(`[worker] Claimed CLO panel job ${panelJob.id}`);
    try {
      const { encrypted, iv } = await getUserApiKey(panelJob.user_id);
      const apiKey = decryptApiKey(encrypted, iv);
      const { members } = await runPanelPipeline(pool, panelJob.profile_id, apiKey, panelJob.raw_files || {}, {
        updatePhase: async (phase) => { console.log(`[worker] CLO panel ${panelJob.id}: ${phase}`); },
        updateRawFiles: async (files) => {
          await pool.query("UPDATE clo_panels SET raw_files = $1::jsonb, updated_at = NOW() WHERE id = $2", [JSON.stringify(files), panelJob.id]);
        },
        updateParsedData: async (data) => {
          const parsed = data as { members: unknown[] };
          await pool.query("UPDATE clo_panels SET members = $1::jsonb, updated_at = NOW() WHERE id = $2", [JSON.stringify(parsed.members || []), panelJob.id]);
        },
      });
      await pool.query("UPDATE clo_panels SET status = 'active', members = $1::jsonb, updated_at = NOW() WHERE id = $2", [JSON.stringify(members), panelJob.id]);
      console.log(`[worker] CLO panel ${panelJob.id} completed with ${members.length} members`);
    } catch (err) {
      await handleCloJobError("clo_panels", panelJob.id, panelJob.user_id, err);
    }
  }

  // Analysis jobs
  const analysisJob = await claimAnalysisJob();
  if (analysisJob) {
    console.log(`[worker] Claimed CLO analysis job ${analysisJob.id}`);
    try {
      const { encrypted, iv } = await getUserApiKey(analysisJob.user_id);
      const apiKey = decryptApiKey(encrypted, iv);
      await runAnalysisPipeline(pool, analysisJob.id, apiKey, analysisJob.raw_files || {}, {
        updatePhase: async (phase) => {
          console.log(`[worker] CLO analysis ${analysisJob.id}: ${phase}`);
          await pool.query("UPDATE clo_analyses SET current_phase = $1 WHERE id = $2", [phase, analysisJob.id]);
        },
        updateRawFiles: async (files) => {
          await pool.query("UPDATE clo_analyses SET raw_files = $1::jsonb WHERE id = $2", [JSON.stringify(files), analysisJob.id]);
        },
        updateParsedData: async (data) => {
          await pool.query("UPDATE clo_analyses SET parsed_data = $1::jsonb WHERE id = $2", [JSON.stringify(data), analysisJob.id]);
        },
      });
      await pool.query("UPDATE clo_analyses SET status = 'complete', completed_at = NOW() WHERE id = $1", [analysisJob.id]);
      console.log(`[worker] CLO analysis ${analysisJob.id} completed`);
    } catch (err) {
      await handleCloJobError("clo_analyses", analysisJob.id, analysisJob.user_id, err);
    }
  }

  // Screening jobs
  const screeningJob = await claimScreeningJob();
  if (screeningJob) {
    console.log(`[worker] Claimed CLO screening job ${screeningJob.id}`);
    try {
      const { encrypted, iv } = await getUserApiKey(screeningJob.user_id);
      const apiKey = decryptApiKey(encrypted, iv);
      await runScreeningPipeline(pool, screeningJob.id, apiKey, screeningJob.raw_files || {}, {
        updatePhase: async (phase) => {
          console.log(`[worker] CLO screening ${screeningJob.id}: ${phase}`);
          await pool.query("UPDATE clo_screenings SET current_phase = $1 WHERE id = $2", [phase, screeningJob.id]);
        },
        updateRawFiles: async (files) => {
          await pool.query("UPDATE clo_screenings SET raw_files = $1::jsonb WHERE id = $2", [JSON.stringify(files), screeningJob.id]);
        },
        updateParsedData: async (data) => {
          await pool.query("UPDATE clo_screenings SET parsed_data = $1::jsonb WHERE id = $2", [JSON.stringify(data), screeningJob.id]);
        },
      });
      await pool.query("UPDATE clo_screenings SET status = 'complete', completed_at = NOW() WHERE id = $1", [screeningJob.id]);
      console.log(`[worker] CLO screening ${screeningJob.id} completed`);
    } catch (err) {
      await handleCloJobError("clo_screenings", screeningJob.id, screeningJob.user_id, err);
    }
  }
}

// ─── CLO Extraction Jobs ─────────────────────────────────────────────

async function pollCloExtractionJobs() {
  // Recover stale PPM 'extracting' jobs (stuck > 10 min)
  await pool.query(
    `UPDATE clo_profiles SET ppm_extraction_status = 'queued'
     WHERE ppm_extraction_status = 'extracting'
       AND updated_at < NOW() - INTERVAL '10 minutes'`
  );

  // PPM extraction
  const ppmJob = await pool.query<{
    id: string;
    user_id: string;
    documents: Array<{ name: string; type: string; size: number; base64: string; docType?: "ppm" | "compliance" }>;
  }>(
    `UPDATE clo_profiles SET ppm_extraction_status = 'extracting',
       ppm_extraction_progress = '{"step":"starting","detail":"Starting PPM extraction..."}'::jsonb,
       updated_at = NOW()
     WHERE id = (
       SELECT id FROM clo_profiles
       WHERE ppm_extraction_status = 'queued'
       ORDER BY updated_at LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, user_id, documents`
  );

  if (ppmJob.rows.length > 0) {
    const job = ppmJob.rows[0];
    console.log(`[worker] Claimed PPM extraction job for profile ${job.id}`);
    try {
      const { encrypted, iv } = await getUserApiKey(job.user_id);
      const apiKey = decryptApiKey(encrypted, iv);
      // Filter to only PPM documents (backwards compat: no docType = ppm)
      const ppmDocs = (job.documents || []).filter((d) => (d.docType || "ppm") === "ppm");
      const ppmProgress = async (step: string, detail?: string) => {
        await pool.query(
          `UPDATE clo_profiles SET ppm_extraction_progress = $1::jsonb, updated_at = now() WHERE id = $2`,
          [JSON.stringify({ step, detail, updatedAt: new Date().toISOString() }), job.id]
        );
      };
      const { extractedConstraints, rawOutputs } = await runSectionPpmExtraction(apiKey, ppmDocs, ppmProgress);

      await pool.query(
        `UPDATE clo_profiles
         SET extracted_constraints = $1::jsonb,
             ppm_raw_extraction = $2::jsonb,
             ppm_extracted_at = now(),
             ppm_extraction_status = 'complete',
             ppm_extraction_error = NULL,
             ppm_extraction_progress = $3::jsonb,
             updated_at = now()
         WHERE id = $4`,
        [JSON.stringify(extractedConstraints), JSON.stringify(rawOutputs), JSON.stringify({ step: "complete", detail: "Extraction complete", updatedAt: new Date().toISOString() }), job.id]
      );

      // Sync PPM data to relational tables (tranches, deals)
      try {
        await syncPpmToRelationalTables(pool, job.id, extractedConstraints);
      } catch (syncErr) {
        console.error(`[worker] PPM relational sync failed for profile ${job.id}:`, syncErr instanceof Error ? syncErr.message : syncErr);
      }

      console.log(`[worker] PPM extraction complete for profile ${job.id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(`[worker] PPM extraction failed for profile ${job.id}: ${message}`);
      await pool.query(
        `UPDATE clo_profiles
         SET ppm_extraction_status = 'error',
             ppm_extraction_error = $1,
             ppm_extraction_progress = $2::jsonb,
             updated_at = now()
         WHERE id = $3`,
        [message, JSON.stringify({ step: "error", detail: message, updatedAt: new Date().toISOString() }), job.id]
      );
    }
  }

  // Compliance report extraction — also recover stale 'extracting' jobs (stuck > 10 min)
  await pool.query(
    `UPDATE clo_profiles SET report_extraction_status = 'queued'
     WHERE report_extraction_status = 'extracting'
       AND updated_at < NOW() - INTERVAL '10 minutes'`
  );

  const reportJob = await pool.query<{
    id: string;
    user_id: string;
    documents: Array<{ name: string; type: string; size: number; base64: string; docType?: "ppm" | "compliance" }>;
  }>(
    `UPDATE clo_profiles SET report_extraction_status = 'extracting',
       report_extraction_progress = '{"step":"starting","detail":"Starting report extraction..."}'::jsonb,
       updated_at = NOW()
     WHERE id = (
       SELECT id FROM clo_profiles
       WHERE report_extraction_status = 'queued'
       ORDER BY updated_at LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, user_id, documents`
  );

  if (reportJob.rows.length > 0) {
    const job = reportJob.rows[0];
    console.log(`[worker] Claimed report extraction job for profile ${job.id}`);
    try {
      const { encrypted, iv } = await getUserApiKey(job.user_id);
      const apiKey = decryptApiKey(encrypted, iv);
      const complianceDocs = (job.documents || []).filter((d) => d.docType === "compliance");
      if (complianceDocs.length === 0) {
        console.log(`[worker] No compliance docs for profile ${job.id}, skipping report extraction`);
        await pool.query(
          `UPDATE clo_profiles SET report_extraction_status = 'complete', report_extraction_error = NULL, updated_at = now() WHERE id = $1`,
          [job.id]
        );
      } else {
        await runSectionExtraction(job.id, apiKey, complianceDocs, async (step, detail) => {
          await pool.query(
            `UPDATE clo_profiles SET report_extraction_progress = $1::jsonb, updated_at = now() WHERE id = $2`,
            [JSON.stringify({ step, detail, updatedAt: new Date().toISOString() }), job.id],
          );
        });
        await pool.query(
          `UPDATE clo_profiles
           SET report_extraction_status = 'complete',
               report_extraction_error = NULL,
               report_extraction_progress = $1::jsonb,
               updated_at = now()
           WHERE id = $2`,
          [JSON.stringify({ step: "complete", detail: "Extraction complete", updatedAt: new Date().toISOString() }), job.id]
        );
        console.log(`[worker] Report extraction complete for profile ${job.id}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(`[worker] Report extraction failed for profile ${job.id}: ${message}`);
      await pool.query(
        `UPDATE clo_profiles
         SET report_extraction_status = 'error',
             report_extraction_error = $1,
             report_extraction_progress = $2::jsonb,
             updated_at = now()
         WHERE id = $3`,
        [message, JSON.stringify({ step: "error", detail: message, updatedAt: new Date().toISOString() }), job.id]
      );
    }
  }

  // Portfolio extraction
  const portfolioJob = await pool.query<{
    id: string;
    user_id: string;
    documents: Array<{ name: string; type: string; size: number; base64: string; docType?: "ppm" | "compliance" }>;
  }>(
    `UPDATE clo_profiles SET portfolio_extraction_status = 'extracting', updated_at = NOW()
     WHERE id = (
       SELECT id FROM clo_profiles
       WHERE portfolio_extraction_status = 'queued'
       ORDER BY updated_at LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, user_id, documents`
  );

  if (portfolioJob.rows.length > 0) {
    const job = portfolioJob.rows[0];
    console.log(`[worker] Claimed portfolio extraction job for profile ${job.id}`);
    try {
      const { encrypted, iv } = await getUserApiKey(job.user_id);
      const apiKey = decryptApiKey(encrypted, iv);
      // Filter to only compliance documents; skip if none exist
      const complianceDocs = (job.documents || []).filter((d) => d.docType === "compliance");
      if (complianceDocs.length === 0) {
        console.log(`[worker] No compliance docs for profile ${job.id}, skipping portfolio extraction`);
        await pool.query(
          `UPDATE clo_profiles SET portfolio_extraction_status = 'complete', portfolio_extraction_error = NULL, updated_at = now() WHERE id = $1`,
          [job.id]
        );
        return;
      }
      const extractedPortfolio = await runPortfolioExtraction(apiKey, complianceDocs);

      await pool.query(
        `UPDATE clo_profiles
         SET extracted_portfolio = $1::jsonb,
             portfolio_extraction_status = 'complete',
             portfolio_extraction_error = NULL,
             updated_at = now()
         WHERE id = $2`,
        [JSON.stringify(extractedPortfolio), job.id]
      );
      console.log(`[worker] Portfolio extraction complete for profile ${job.id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(`[worker] Portfolio extraction failed for profile ${job.id}: ${message}`);
      await pool.query(
        `UPDATE clo_profiles
         SET portfolio_extraction_status = 'error',
             portfolio_extraction_error = $1,
             updated_at = now()
         WHERE id = $2`,
        [message, job.id]
      );
    }
  }
}

// ─── Poll Loop ──────────────────────────────────────────────────────

async function pollLoop() {
  console.log("[worker] Starting poll loop");

  while (true) {
    try {
      // Assembly jobs
      const job = await claimJob();
      if (job) {
        console.log(
          `[worker] Claimed job ${job.id}: "${job.topic_input.slice(0, 80)}"`
        );
        try {
          await processJob(job);
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "Unknown error";
          console.error(`[worker] Job ${job.id} failed: ${message}`);
          await pool.query(
            `UPDATE assemblies SET status = 'error', error_message = $1 WHERE id = $2`,
            [message, job.id]
          );
          if (message.includes("Invalid API key")) {
            await pool.query(
              "UPDATE users SET api_key_valid = false WHERE id = $1",
              [job.user_id]
            );
          }
          // Reset free trial if this was a trial assembly that failed
          const trialCheck = await pool.query(
            "SELECT is_free_trial FROM assemblies WHERE id = $1",
            [job.id]
          );
          if (trialCheck.rows[0]?.is_free_trial) {
            await resetFreeTrial(job.user_id);
            await pool.query("DELETE FROM assemblies WHERE id = $1", [job.id]);
            console.log(`[worker] Reset free trial for user ${job.user_id} after assembly failure`);
          }
        }
      }

      // IC jobs
      await pollIcJobs();

      // CLO jobs
      await pollCloJobs();

      // CLO extraction jobs (PPM + portfolio)
      await pollCloExtractionJobs();

      // Daily briefing
      await maybeFetchBriefing();
    } catch (err) {
      console.error("[worker] Poll error:", err);
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

pollLoop();
