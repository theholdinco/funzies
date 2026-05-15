import { describe, it, expect } from "vitest";
import { parseCollateralFile } from "../sdf/parse-collateral";

const HEADER =
  "Deal_Name,Issuer_Name,Security_Name,Principal_Funded_Balance,Native_Principal_Funded_Balance,Commitment,Native_Commitment,Principal_Balance,Native_Principal_Balance,Native_Currency,Gross_Purchase_Price,Premium_Discount,Discount,Premium,Security_Type1,FRN_Clarification,Contract,CUSIP,ISIN,Security_Facility_Code,Country_Name,Country_Code,Coupon_Type,All_In_Rate,Index_Type,Index,Index_Floor_Rate,Current_Spread,Month_Count,Year_Count,Current_Interest_Accrual_Begin_Date,Current_Interest_Accrual_End_Date,Payment_Period,Issuer_Industry_Classification___S_P,Moodys_Industry_Name,Fitch_Industry_Name,Moodys_Rating,SP_Rating,Fitch_Rating,Moodys_Recovery_Rate,SP_Recovery_Rate,Fitch_Recovery_Rate,Issue_Date,Maturity_Date,Default_Date,Reason_for_Default,Next_Payment_Date,AffiliateID,LoanX_ID,Is_Mezzanine,Is_Second_Lein,Cov_Lite,Security_Level,Market_Value";

const ROW_1 =
  "Ares European CLO XV  DAC,Admiral Bidco GmbH,Facility B2,2131336.410,2131336.410,2131336.410,2131336.410,2131336.410,2131336.410,EUR,98.000,Discount,42626.728,,Loan,,,,,APLEONA_HOLDING_GMBH_1_TLB,Germany,221,Floating,5.15,EURIBOR (1 month),1.9,0,3.25,Actual,360,01.04.2026,30.04.2026,1 Month,Real Estate Management & Development,Services: Business,Business Services,B2,,B,45,,57,01.04.2026,29.09.2032,,,30.04.2026,,LX284437,FALSE,FALSE,FALSE,Senior Secured,99.542";

const ROW_2 =
  "Ares European CLO XV  DAC,Aenova Holding GmbH,Facility B1,1000000.000,1000000.000,1000000.000,1000000.000,1000000.000,1000000.000,EUR,100.000,,,,Loan,,,,,AENOVA _TLB_12,Germany,221,Floating,5.011,EURIBOR (3 months),2.011,0,3,Actual,360,27.02.2026,29.05.2026,3 Months,Health Care Providers & Services,Healthcare & Pharmaceuticals,Healthcare,B1,,B+,45,,65,28.02.2025,22.08.2031,,,29.05.2026,,LX258369,FALSE,FALSE,FALSE,Senior Secured,100.094";

const ROW_3 =
  "Ares European CLO XV  DAC,Aernnova Aerospace S.A.U.,Eur Term Loan B 2024,2000000.000,2000000.000,2000000.000,2000000.000,2000000.000,2000000.000,EUR,99.875,Discount,2500.000,,Loan,,,,,AERNNOVA_AERO_SAU_TERM_LOAN,Spain,232,Floating,6.026,EURIBOR (3 months),2.026,0,4,Actual,360,08.01.2026,08.04.2026,3 Months,Aerospace & Defense,Aerospace & Defense,Aerospace & Defense,B3,,B,45,,51,11.06.2024,27.02.2030,,,08.04.2026,,LX236054,FALSE,FALSE,FALSE,Senior Secured,96.688";

function makeCsv(...dataRows: string[]): string {
  return [HEADER, ...dataRows].join("\n");
}

describe("parseCollateralFile", () => {
  it("parses obligor name, facility name, par balance correctly", () => {
    const result = parseCollateralFile(makeCsv(ROW_1));
    const row = result.rows[0];
    expect(row.obligor_name).toBe("Admiral Bidco GmbH");
    expect(row.facility_name).toBe("Facility B2");
    expect(row.par_balance).toBeCloseTo(2131336.41);
  });

  it("computes unfunded_commitment (Commitment - Principal_Funded_Balance)", () => {
    const result = parseCollateralFile(makeCsv(ROW_1));
    const row = result.rows[0];
    // Commitment and Principal_Funded_Balance are equal → unfunded = 0
    expect(row.unfunded_commitment).toBeCloseTo(0);
  });

  it("converts spread 3.25 to 325 bps", () => {
    const result = parseCollateralFile(makeCsv(ROW_1));
    expect(result.rows[0].spread_bps).toBe(325);
  });

  it("parses SDF percent-scale price/rate fields with three decimals", () => {
    const result = parseCollateralFile(makeCsv(ROW_1, ROW_2));
    const first = result.rows[0];
    const second = result.rows[1];

    expect(first.gross_purchase_price).toBe(98);
    expect(first.purchase_price).toBe(98);
    expect(first.market_value).toBe(99.542);
    expect(first.current_price).toBe(99.542);
    expect(first.all_in_rate).toBe(5.15);
    expect(first.index_rate).toBe(1.9);
    expect(first.floor_rate).toBe(0);
    expect(first.recovery_rate_moodys).toBe(45);
    expect(first.recovery_rate_fitch).toBe(57);
    expect(second.market_value).toBe(100.094);
    expect(second.all_in_rate).toBe(5.011);
    expect(second.index_rate).toBe(2.011);
  });

  it("derives is_defaulted = true when Default_Date is present", () => {
    const rowWithDefault = ROW_1.replace(",,,30.04.2026", ",15.03.2026,Credit Event,30.04.2026");
    const result = parseCollateralFile(makeCsv(rowWithDefault));
    const row = result.rows[0];
    expect(row.is_defaulted).toBe(true);
    expect(row.default_date).toBe("2026-03-15");
    expect(row.default_reason).toBe("Credit Event");
  });

  it("derives is_defaulted = false when Default_Date is empty", () => {
    const result = parseCollateralFile(makeCsv(ROW_1));
    expect(result.rows[0].is_defaulted).toBe(false);
    expect(result.rows[0].default_date).toBeNull();
  });

  it("derives is_fixed_rate from Coupon_Type", () => {
    const result = parseCollateralFile(makeCsv(ROW_1));
    expect(result.rows[0].is_fixed_rate).toBe(false); // Floating

    const fixedRow = ROW_1.replace(",Floating,", ",Fixed,");
    const result2 = parseCollateralFile(makeCsv(fixedRow));
    expect(result2.rows[0].is_fixed_rate).toBe(true);
  });

  it("sets security_level from Security_Level column (not Is_Mezzanine)", () => {
    const result = parseCollateralFile(makeCsv(ROW_1));
    expect(result.rows[0].security_level).toBe("Senior Secured");
  });

  it("sets lien_type = 'Second Lien' from Is_Second_Lein = TRUE", () => {
    const secondLienRow = ROW_1.replace(",FALSE,FALSE,Senior Secured", ",TRUE,FALSE,Senior Secured");
    const result = parseCollateralFile(makeCsv(secondLienRow));
    expect(result.rows[0].lien_type).toBe("Second Lien");
  });

  it("parses DD.MM.YYYY dates to ISO format", () => {
    const result = parseCollateralFile(makeCsv(ROW_1));
    const row = result.rows[0];
    expect(row.accrual_begin_date).toBe("2026-04-01");
    expect(row.accrual_end_date).toBe("2026-04-30");
    expect(row.issue_date).toBe("2026-04-01");
    expect(row.maturity_date).toBe("2032-09-29");
    expect(row.next_payment_date).toBe("2026-04-30");
  });

  it("trims ratings (removes trailing whitespace)", () => {
    const result = parseCollateralFile(makeCsv(ROW_1));
    const row = result.rows[0];
    expect(row.moodys_rating).toBe("B2");
    expect(row.sp_rating).toBeNull(); // empty field
    expect(row.fitch_rating).toBe("B");
  });

  it("parses boolean flags (TRUE/FALSE)", () => {
    const result = parseCollateralFile(makeCsv(ROW_1));
    expect(result.rows[0].is_cov_lite).toBe(false);
  });

  it("sets data_source = 'sdf'", () => {
    const result = parseCollateralFile(makeCsv(ROW_1));
    expect(result.rows[0].data_source).toBe("sdf");
  });

  it("combines Month_Count/Year_Count into day_count_convention", () => {
    const result = parseCollateralFile(makeCsv(ROW_1));
    expect(result.rows[0].day_count_convention).toBe("Actual/360");
  });

  it("handles Premium_Discount text column without crashing", () => {
    const result = parseCollateralFile(makeCsv(ROW_1));
    // "Discount" is not numeric, parseNumeric returns null
    expect(result.rows[0].premium_discount_amount).toBeNull();
    // The Discount numeric column should parse fine
    expect(result.rows[0].discount_amount).toBeCloseTo(42626.728);
  });

  it("returns correct rowCount and dealName", () => {
    const result = parseCollateralFile(makeCsv(ROW_1, ROW_2, ROW_3));
    expect(result.rowCount).toBe(3);
    expect(result.rows).toHaveLength(3);
    expect(result.dealName).toBe("Ares European CLO XV  DAC");
    expect(result.fileType).toBe("collateral_file");
  });
});

/**
 * Bond par_balance fallback: when Principal_Funded_Balance == 0 (the SDF
 * convention for bonds, which carry no funded/unfunded distinction), the
 * parser must fall back to `Commitment` (live PIK-accreted face) rather
 * than `Principal_Balance` (original face). Direct disk verification on
 * the Euro XV 2026-04-01 SDF: Tele Columbus 4 slices have
 *   PFB = 0
 *   Σ Principal_Balance = 2,500,000 (original)
 *   Σ Commitment        = 3,081,032.34 (live)
 *   Asset_Level PIK_Amount = 581,032.34 = Commitment − Principal_Balance to the cent
 * Non-PIK bonds (Allwyn Entertainment, Altice Financing, etc.) all show
 * PB == Commitment exactly, so the fallback is value-equivalent on the
 * non-accreting majority.
 */
const PFB_INDEX = 3; // 0-based
const COMMITMENT_INDEX = 5;
const PRINCIPAL_BALANCE_INDEX = 7;
const SECURITY_TYPE_INDEX = 14;

function withFields(
  template: string,
  patches: Array<[index: number, value: string]>,
): string {
  const cols = template.split(",");
  for (const [idx, val] of patches) cols[idx] = val;
  return cols.join(",");
}

describe("parseCollateralFile — bond par_balance fallback (Commitment vs Principal_Balance)", () => {
  it("PIK toggle-off bond (Tele shape): PFB=0, Commitment > PB → par_balance follows Commitment", () => {
    const teleSlice1 = withFields(ROW_1, [
      [PFB_INDEX, "0.000"],
      [PFB_INDEX + 1, "0.000"],
      [COMMITMENT_INDEX, "1232412.93"],
      [COMMITMENT_INDEX + 1, "1232412.93"],
      [PRINCIPAL_BALANCE_INDEX, "1000000.000"],
      [PRINCIPAL_BALANCE_INDEX + 1, "1000000.000"],
      [SECURITY_TYPE_INDEX, "Bond"],
    ]);
    const result = parseCollateralFile(makeCsv(teleSlice1));
    const row = result.rows[0];

    // Live face captures the 232,412.93 of accreted PIK on this slice.
    expect(row.par_balance).toBeCloseTo(1232412.93);
    // Pre-fix behavior would have been 1,000,000 (original face). The gap
    // between the two paths IS the per-slice cumulative PIK accretion.
    expect(row.par_balance).not.toBeCloseTo(1000000);
    // principal_balance still surfaces the raw original face for
    // observability — only par_balance flips to live.
    expect(row.principal_balance).toBeCloseTo(1000000);
  });

  it("non-accreting bond (Allwyn shape): PFB=0, Commitment == PB → par_balance equals both (no regression)", () => {
    const nonPikBond = withFields(ROW_1, [
      [PFB_INDEX, "0.000"],
      [PFB_INDEX + 1, "0.000"],
      [COMMITMENT_INDEX, "500000.000"],
      [COMMITMENT_INDEX + 1, "500000.000"],
      [PRINCIPAL_BALANCE_INDEX, "500000.000"],
      [PRINCIPAL_BALANCE_INDEX + 1, "500000.000"],
      [SECURITY_TYPE_INDEX, "Bond"],
    ]);
    const result = parseCollateralFile(makeCsv(nonPikBond));
    expect(result.rows[0].par_balance).toBeCloseTo(500000);
  });

  it("loan path (PFB > 0) is unchanged — Commitment fallback only kicks in when PFB is null/zero", () => {
    // ROW_1 is a Loan with PFB = Commitment = PB = 2,131,336.41. Verify the
    // result still matches PFB exactly (i.e. the Commitment branch did not
    // displace the loan path).
    const result = parseCollateralFile(makeCsv(ROW_1));
    expect(result.rows[0].par_balance).toBeCloseTo(2131336.41);
  });

  it("compound Security_Type1 (e.g., 'Senior Secured Bond'): isBond regex matches → routes through Commitment", () => {
    // Anti-pattern #1 cross-trustee guard. The DDTL detection pattern
    // in the same file uses a regex (`/delayed.{0,5}draw/i`) precisely
    // because Security_Type1 values vary by trustee — compound shapes
    // like "Senior Secured Bond", "HY Bond", "PIK Bond" all need to
    // match the bond branch. Strict equality on "bond" would fall
    // through to Principal_Balance and silently drop accreted PIK.
    const compoundBond = withFields(ROW_1, [
      [PFB_INDEX, "0.000"],
      [PFB_INDEX + 1, "0.000"],
      [COMMITMENT_INDEX, "1232412.93"],
      [COMMITMENT_INDEX + 1, "1232412.93"],
      [PRINCIPAL_BALANCE_INDEX, "1000000.000"],
      [PRINCIPAL_BALANCE_INDEX + 1, "1000000.000"],
      [SECURITY_TYPE_INDEX, "Senior Secured Bond"], // compound variant
    ]);
    const result = parseCollateralFile(makeCsv(compoundBond));
    // Live face captured — accreted PIK preserved on the compound type.
    expect(result.rows[0].par_balance).toBeCloseTo(1232412.93);
  });

  it("loan with PFB=0 (undrawn revolver / fully-undrawn DDTL): par_balance does NOT follow Commitment — anti-pattern #1 cross-deal guard", () => {
    // The PFB-zero shape on a Loan row means "genuinely zero drawn par"
    // (undrawn revolver, fully-unfunded DDTL), not "use Commitment as live
    // face." Routing that through Commitment would set par_balance = full
    // undrawn capacity, over-counting the OC numerator on any deal whose
    // SDF carries an undrawn loan facility. Euro XV has zero such rows
    // today (every PFB=0 row is a Bond), but the convention is portable:
    // a partially-drawn DDTL on the next deal (or on Euro XV next quarter)
    // would silently inflate par by the full undrawn amount without this
    // gate. PIK accretion only applies to bonds, so the Commitment branch
    // is correctly bond-only.
    const undrawnLoan = withFields(ROW_1, [
      [PFB_INDEX, "0.000"],
      [PFB_INDEX + 1, "0.000"],
      [COMMITMENT_INDEX, "5000000.000"],
      [COMMITMENT_INDEX + 1, "5000000.000"],
      [PRINCIPAL_BALANCE_INDEX, "0.000"],
      [PRINCIPAL_BALANCE_INDEX + 1, "0.000"],
      [SECURITY_TYPE_INDEX, "Loan"], // explicitly NOT Bond
    ]);
    const result = parseCollateralFile(makeCsv(undrawnLoan));
    // Must NOT route to Commitment (5M) — that would over-count par.
    expect(result.rows[0].par_balance).not.toBeCloseTo(5_000_000);
    // Loan path with PFB=0 falls through to Principal_Balance (0 here).
    expect(result.rows[0].par_balance).toBeCloseTo(0);
  });

  it("graceful fallback when Commitment is also missing: par_balance falls through to Principal_Balance", () => {
    const noCommitmentBond = withFields(ROW_1, [
      [PFB_INDEX, "0.000"],
      [PFB_INDEX + 1, "0.000"],
      [COMMITMENT_INDEX, ""],
      [COMMITMENT_INDEX + 1, ""],
      [PRINCIPAL_BALANCE_INDEX, "750000.000"],
      [PRINCIPAL_BALANCE_INDEX + 1, "750000.000"],
      [SECURITY_TYPE_INDEX, "Bond"],
    ]);
    const result = parseCollateralFile(makeCsv(noCommitmentBond));
    expect(result.rows[0].par_balance).toBeCloseTo(750000);
  });
});
