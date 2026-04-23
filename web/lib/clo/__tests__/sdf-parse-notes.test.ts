import { describe, it, expect } from "vitest";
import { parseNotes } from "../sdf/parse-notes";

const HEADER =
  "Deal_Name,Tranche_Name,Tranche_Type,Liab_Prin,CUSIP,ISIN,Original_Amount,SP_Rating,SP_Rating_Issuance,Fitch_Rating,Moodys_Rating,Fitch_Rating_Issuance,Moodys_Rating_Issuance,Current_Principal,Spread,Interest,IC_Interest,Amount_Native,Currency_Identifier,Unscheduled_Principal_Paydown,CRY_Maturity_Date,Maturity_Date,Base_Rate,Rate_Index,Coupon,Start_Date,End_Date,Payment_Frequency,Tranche_Month_Count,Tranche_Year_Count,NoteID,AssetID,BNY_LiabOuts_userstring1,LiabOut_UserPercentage1,BNY_LiabOuts_Useramt1,BNY_LiabOuts_Useramt2";

const ROW_CLASS_A =
  "Ares European CLO XV  DAC,Class A Senior Secured Floating Rate Notes due 2032,,,,,,,,AAA ,Aaa ,AAA ,Aaa ,310000000.0000,0.95,,,310000000.0000,EUR,,,15.01.2036,,EURIBOR (3 months),2.966,06.01.2026,03.04.2026,3 Months,Actual,360,,,,,,";

const ROW_CLASS_B1 =
  "Ares European CLO XV  DAC,Class B-1 Senior Secured Floating Rate Notes due 2032,,,,,,,,AA  ,Aa2 ,AA  ,Aa2 ,33750000.0000,1.7,,,33750000.0000,EUR,,,15.01.2036,,EURIBOR (3 months),3.716,06.01.2026,03.04.2026,3 Months,Actual,360,,,,,,";

const ROW_CLASS_B2 =
  "Ares European CLO XV  DAC,Class B-2 Senior Secured Fixed Rate Notes due 2032,,,,,,,,AA  ,Aa2 ,AA  ,Aa2 ,15000000.0000,,,,15000000.0000,EUR,,,15.01.2036,,,1.95,06.01.2026,03.04.2026,3 Months,30,360 (European),,,,,,";

const ROW_CLASS_C =
  "Ares European CLO XV  DAC,Class C Senior Secured Deferrable Floating Rate Notes due 2032,,,,,,,,A   ,A2  ,A   ,A2  ,32500000.0000,2.1,,,32500000.0000,EUR,,,15.01.2036,,EURIBOR (3 months),4.116,06.01.2026,03.04.2026,3 Months,Actual,360,,,,,,";

const ROW_SUBORDINATED =
  "Ares European CLO XV  DAC,Subordinated Notes due 2032,,,,,,,,NR  ,NR  ,NR  ,NR  ,44800000.0000,0,,,44800000.0000,EUR,,,15.01.2036,,EURIBOR (3 months),0,06.01.2026,03.04.2026,3 Months,Actual,360,,,,,,";

function makeCsv(...dataRows: string[]): string {
  return [HEADER, ...dataRows].join("\n");
}

describe("parseNotes", () => {
  it('normalizes "Class A Senior Secured..." → class_name "Class A"', () => {
    const result = parseNotes(makeCsv(ROW_CLASS_A));
    expect(result.rows[0].class_name).toBe("Class A");
    expect(result.rows[0].raw_tranche_name).toBe(
      "Class A Senior Secured Floating Rate Notes due 2032"
    );
  });

  it('normalizes "Class B-1 Senior Secured..." → "Class B-1"', () => {
    const result = parseNotes(makeCsv(ROW_CLASS_B1));
    expect(result.rows[0].class_name).toBe("Class B-1");
  });

  it('normalizes "Subordinated Notes due 2032" → "Subordinated Notes"', () => {
    const result = parseNotes(makeCsv(ROW_SUBORDINATED));
    expect(result.rows[0].class_name).toBe("Subordinated Notes");
  });

  it("converts spread 0.95 → 95 bps", () => {
    const result = parseNotes(makeCsv(ROW_CLASS_A));
    expect(result.rows[0].spread_bps).toBe(95);
  });

  it("handles fixed-rate tranche (B-2): spread_bps is null, reference_rate is null", () => {
    const result = parseNotes(makeCsv(ROW_CLASS_B2));
    const row = result.rows[0];
    expect(row.spread_bps).toBeNull();
    expect(row.reference_rate).toBeNull();
    expect(row.coupon_rate).toBeCloseTo(1.95);
    expect(row.class_name).toBe("Class B-2");
  });

  it("parses accrual dates correctly (06.01.2026 → 2026-01-06)", () => {
    const result = parseNotes(makeCsv(ROW_CLASS_A));
    const row = result.rows[0];
    expect(row.accrual_start_date).toBe("2026-01-06");
    expect(row.accrual_end_date).toBe("2026-04-03");
  });

  it('trims ratings with trailing whitespace ("AAA " → "AAA", "Aaa " → "Aaa")', () => {
    const result = parseNotes(makeCsv(ROW_CLASS_A));
    const row = result.rows[0];
    expect(row.rating_fitch).toBe("AAA");
    expect(row.rating_moodys).toBe("Aaa");
  });

  it("extracts issuance ratings", () => {
    const result = parseNotes(makeCsv(ROW_CLASS_A));
    const row = result.rows[0];
    expect(row.rating_fitch_issuance).toBe("AAA");
    expect(row.rating_moodys_issuance).toBe("Aaa");
  });

  it('combines day count "Actual" + "360" → "Actual/360"', () => {
    const result = parseNotes(makeCsv(ROW_CLASS_A));
    expect(result.rows[0].day_count_convention).toBe("Actual/360");
  });

  it('combines day count "30" + "360 (European)" → "30/360 (European)"', () => {
    const result = parseNotes(makeCsv(ROW_CLASS_B2));
    expect(result.rows[0].day_count_convention).toBe("30/360 (European)");
  });

  it("returns null for vendor_custom_fields when all BNY fields are empty", () => {
    const result = parseNotes(makeCsv(ROW_CLASS_A));
    expect(result.rows[0].vendor_custom_fields).toBeNull();
  });

  it("packs non-empty vendor custom fields into an object", () => {
    // Inject a value into BNY_LiabOuts_userstring1 (index 32)
    const rowWithVendor = ROW_CLASS_A.replace(/,,,,$/, ",MyLabel,,,");
    const result = parseNotes(makeCsv(rowWithVendor));
    expect(result.rows[0].vendor_custom_fields).toEqual({
      BNY_LiabOuts_userstring1: "MyLabel",
    });
  });

  it("sets data_source = 'sdf'", () => {
    const result = parseNotes(makeCsv(ROW_CLASS_A));
    expect(result.rows[0].data_source).toBe("sdf");
  });

  it("returns correct rowCount for 5 tranches", () => {
    const result = parseNotes(
      makeCsv(
        ROW_CLASS_A,
        ROW_CLASS_B1,
        ROW_CLASS_B2,
        ROW_CLASS_C,
        ROW_SUBORDINATED
      )
    );
    expect(result.rowCount).toBe(5);
    expect(result.rows).toHaveLength(5);
    expect(result.dealName).toBe("Ares European CLO XV  DAC");
    expect(result.fileType).toBe("notes");
  });

  it("parses legal_maturity_date from CRY_Maturity_Date (15.01.2036 → 2036-01-15)", () => {
    const result = parseNotes(makeCsv(ROW_CLASS_A));
    expect(result.rows[0].legal_maturity_date).toBe("2036-01-15");
  });

  it("parses current_balance correctly", () => {
    const result = parseNotes(makeCsv(ROW_CLASS_A));
    expect(result.rows[0].current_balance).toBeCloseTo(310000000);
  });

  it("parses amount_native correctly", () => {
    const result = parseNotes(makeCsv(ROW_CLASS_B1));
    expect(result.rows[0].amount_native).toBeCloseTo(33750000);
  });

  it("parses currency correctly", () => {
    const result = parseNotes(makeCsv(ROW_CLASS_A));
    expect(result.rows[0].currency).toBe("EUR");
  });

  it('normalizes "Class B 1" with space to "Class B-1"', () => {
    const rowB1Space =
      "Ares European CLO XV  DAC,Class B 1 Senior Secured Floating Rate Notes due 2032,,,,,,,,AA  ,Aa2 ,AA  ,Aa2 ,33750000.0000,1.7,,,33750000.0000,EUR,,,15.01.2036,,EURIBOR (3 months),3.716,06.01.2026,03.04.2026,3 Months,Actual,360,,,,,,";
    const result = parseNotes(makeCsv(rowB1Space));
    expect(result.rows[0].class_name).toBe("Class B-1");
  });

  it('treats "NR" as a no-rating sentinel (returns null, not "NR")', () => {
    // Per the rating-sentinel fix: agency "NR" / "N/R" / "***" etc. are
    // sentinels meaning "no rating available" and map to null for consistency
    // with downstream rating-bucket logic. Prior behavior returned "NR" verbatim;
    // new behavior returns null. See web/lib/clo/sdf/csv-utils.ts trimRating().
    const result = parseNotes(makeCsv(ROW_SUBORDINATED));
    const row = result.rows[0];
    expect(row.rating_fitch).toBeNull();
    expect(row.rating_moodys).toBeNull();
  });
});
