import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { query } from "../../db";

const hasTestDb = !!process.env.TEST_DATABASE_URL;
const d = hasTestDb ? describe : describe.skip;

// Unique-ish test profile id used only when TEST_DATABASE_URL is set.
const profileId   = "00000000-0000-0000-0000-0000000000f1";
const userId      = "00000000-0000-0000-0000-0000000000f2";
const dealId      = "00000000-0000-0000-0000-0000000000f3";
const periodId16  = "00000000-0000-0000-0000-000000000016";
const periodId17  = "00000000-0000-0000-0000-000000000017";

async function seedProfileAndPeriods() {
  // Insert minimal user → profile → deal → report_periods scaffolding.
  // Uses ON CONFLICT DO NOTHING so repeated runs don't fail.
  await query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, 'test-payment-history@local', '')
     ON CONFLICT (id) DO NOTHING`,
    [userId]
  );
  await query(
    `INSERT INTO clo_profiles (id, user_id) VALUES ($1, $2)
     ON CONFLICT (id) DO NOTHING`,
    [profileId, userId]
  );
  await query(
    `INSERT INTO clo_deals (id, profile_id, deal_name) VALUES ($1, $2, 'Payment History Test Deal')
     ON CONFLICT (id) DO NOTHING`,
    [dealId, profileId]
  );
  await query(
    `INSERT INTO clo_report_periods (id, deal_id, report_date, extraction_status) VALUES ($1, $2, '2025-04-15', 'complete')
     ON CONFLICT (id) DO NOTHING`,
    [periodId16, dealId]
  );
  await query(
    `INSERT INTO clo_report_periods (id, deal_id, report_date, extraction_status) VALUES ($1, $2, '2025-07-15', 'complete')
     ON CONFLICT (id) DO NOTHING`,
    [periodId17, dealId]
  );
}

async function cleanup() {
  await query(`DELETE FROM clo_payment_history WHERE profile_id = $1`, [profileId]);
}

d("payment history upsert regression", () => {
  beforeAll(async () => { await seedProfileAndPeriods(); });
  beforeEach(async () => { await cleanup(); });
  afterAll(async () => { await cleanup(); });

  it("period-17 ingestion leaves periods 1-16 byte-for-byte unchanged", async () => {
    for (let p = 1; p <= 16; p++) {
      const paymentDate = `2024-${String((p - 1) % 12 + 1).padStart(2, "0")}-15`;
      await query(
        `INSERT INTO clo_payment_history (profile_id, class_name, payment_date, period, interest_paid, principal_paid, cashflow, ending_balance, extracted_value, source_period_id, last_seen_period_id)
         VALUES ($1,'Sub',$2,$3,100,0,100,33000000,$4,$5,$5)`,
        [profileId, paymentDate, p, JSON.stringify({ period: p, interestPaid: 100, principalPaid: 0 }), periodId16]
      );
    }
    const before = await query<{ period: number; extracted_value: unknown; source_period_id: string }>(
      `SELECT period, extracted_value, source_period_id FROM clo_payment_history WHERE profile_id = $1 ORDER BY period`,
      [profileId]
    );

    await query(
      `INSERT INTO clo_payment_history (profile_id, class_name, payment_date, period, interest_paid, principal_paid, cashflow, ending_balance, extracted_value, source_period_id, last_seen_period_id)
       VALUES ($1,'Sub','2025-05-15',17,200,1000,1200,32000000,$2,$3,$3)`,
      [profileId, JSON.stringify({ period: 17, interestPaid: 200, principalPaid: 1000 }), periodId17]
    );

    const after = await query<{ period: number; extracted_value: unknown; source_period_id: string; interest_paid: string }>(
      `SELECT period, extracted_value, source_period_id, interest_paid FROM clo_payment_history WHERE profile_id = $1 ORDER BY period`,
      [profileId]
    );
    expect(after).toHaveLength(17);
    for (let i = 0; i < 16; i++) {
      expect(after[i].extracted_value).toEqual(before[i].extracted_value);
      expect(after[i].source_period_id).toBe(before[i].source_period_id);
    }
    expect(after[16].period).toBe(17);
    expect(after[16].interest_paid).toBe("200");
  });

  it("override_value survives re-extraction of same period", async () => {
    const paymentDate = "2024-07-15";
    await query(
      `INSERT INTO clo_payment_history (profile_id, class_name, payment_date, period, interest_paid, extracted_value, override_value, override_reason, overridden_by, overridden_at, source_period_id, last_seen_period_id)
       VALUES ($1,'Sub',$2,1,100,$3,$4,'manual correction','test',NOW(),$5,$5)`,
      [profileId, paymentDate, JSON.stringify({ interestPaid: 100 }), JSON.stringify({ interestPaid: 999 }), periodId16]
    );
    await query(
      `INSERT INTO clo_payment_history (profile_id, class_name, payment_date, period, interest_paid, extracted_value, source_period_id, last_seen_period_id)
       VALUES ($1,'Sub',$2,1,150,$3,$4,$4)
       ON CONFLICT (profile_id, class_name, payment_date) DO UPDATE SET
         interest_paid = EXCLUDED.interest_paid,
         extracted_value = EXCLUDED.extracted_value,
         updated_at = NOW()`,
      [profileId, paymentDate, JSON.stringify({ interestPaid: 150 }), periodId17]
    );
    const rows = await query<{ override_value: unknown; extracted_value: unknown }>(
      `SELECT override_value, extracted_value FROM clo_payment_history WHERE profile_id = $1`,
      [profileId]
    );
    expect(rows[0].override_value).toEqual({ interestPaid: 999 });
    expect(rows[0].extracted_value).toEqual({ interestPaid: 150 });
  });

  it("generated transaction_type classifies rows correctly", async () => {
    const inserts = [
      { date: "2024-04-17", period: 0, interest: 0,      principal: -31_492_500, ending: 33_150_000,  expected: "SALE" },
      { date: "2024-07-15", period: 1, interest: 0,      principal: 0,           ending: 33_150_000,  expected: "NO_PAYMENT" },
      { date: "2025-01-15", period: 4, interest: 150_000, principal: 500_000,    ending: 309_500_000, expected: "INTEREST_AND_PRINCIPAL_PAYMENT" },
      { date: "2025-02-15", period: 5, interest: 0,      principal: 200_000,     ending: 309_300_000, expected: "PRINCIPAL_PAYMENT" },
      { date: "2025-03-15", period: 6, interest: 50_000,  principal: 0,           ending: 309_300_000, expected: "INTEREST_PAYMENT" },
      { date: "2025-04-15", period: 7, interest: 0,      principal: 309_300_000, ending: 0,           expected: "REDEMPTION" },
    ];
    for (const ins of inserts) {
      await query(
        `INSERT INTO clo_payment_history (profile_id, class_name, payment_date, period, interest_paid, principal_paid, ending_balance, extracted_value, source_period_id, last_seen_period_id)
         VALUES ($1,'A',$2,$3,$4,$5,$6,'{}',$7,$7)`,
        [profileId, ins.date, ins.period, ins.interest, ins.principal, ins.ending, periodId16]
      );
    }
    const rows = await query<{ period: number; transaction_type: string }>(
      `SELECT period, transaction_type FROM clo_payment_history WHERE profile_id = $1 ORDER BY period`,
      [profileId]
    );
    for (const ins of inserts) {
      expect(rows.find(r => r.period === ins.period)?.transaction_type).toBe(ins.expected);
    }
  });
});
