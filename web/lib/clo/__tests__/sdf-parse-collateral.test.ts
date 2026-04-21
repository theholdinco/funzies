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
