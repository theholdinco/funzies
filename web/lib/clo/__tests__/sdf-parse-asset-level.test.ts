import { describe, it, expect } from "vitest";
import { parseAssetLevel } from "../sdf/parse-asset-level";

const HEADER =
  "Deal_Name,Period_Begin_Date,As_Of_Date,Issuer_Name,Security_Name,LoanX_ID,Mark_Price,Moodys_Recovery_Rate,Fitch_Recovery_Rate,Currency,PIK_Amount,Current_Facility_Spread_PIK";

const ROW =
  "Ares European CLO XV  DAC,06 Jan 2026,01 Apr 2026,Admiral Bidco GmbH,Facility B2,LX284437,99.542,0.45,0.57,EUR,0.0000,0";

function makeCsv(...dataRows: string[]): string {
  return [HEADER, ...dataRows].join("\n");
}

describe("parseAssetLevel", () => {
  it("parses Mark_Price as a percent-scale price when it has three decimals", () => {
    const result = parseAssetLevel(makeCsv(ROW));

    expect(result.fileType).toBe("asset_level");
    expect(result.periodBeginDate).toBe("2026-01-06");
    expect(result.asOfDate).toBe("2026-04-01");
    expect(result.rows[0].issuer_name).toBe("Admiral Bidco GmbH");
    expect(result.rows[0].current_price).toBe(99.542);
  });
});
