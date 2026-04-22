import { describe, it, expect } from "vitest";
import { normalizeSectionResults } from "../extraction/normalizer";

const reportPeriodId = "00000000-0000-0000-0000-000000000001";
const dealId = "00000000-0000-0000-0000-000000000002";

describe("normalizeSectionResults — paymentHistory", () => {
  it("flattens perTranche into rows with className", () => {
    const sections = {
      notes_information: {
        perTranche: {
          "A":   [{ period: 1, paymentDate: "2024-07-15", parCommitment: 310_000_000, factor: 1.0, interestPaid: 100_000, principalPaid: 0, cashflow: 100_000, endingBalance: 310_000_000, interestShortfall: 0, accumInterestShortfall: 0 }],
          "Sub": [{ period: 1, paymentDate: "2024-07-15", parCommitment: 33_150_000,  factor: 1.0, interestPaid: 0,       principalPaid: 0, cashflow: 0,       endingBalance: 33_150_000,  interestShortfall: 0, accumInterestShortfall: 0 }],
        },
      },
    };
    const { paymentHistory } = normalizeSectionResults(sections as never, reportPeriodId, dealId);
    expect(paymentHistory).toHaveLength(2);
    expect(paymentHistory.find(r => r.className === "A")).toBeDefined();
    expect(paymentHistory.find(r => r.className === "Sub")).toBeDefined();
  });

  it("deduplicates by (className, paymentDate)", () => {
    const sections = {
      notes_information: {
        perTranche: {
          "A": [
            { period: 1, paymentDate: "2024-07-15", parCommitment: 100, factor: 1, interestPaid: 10, principalPaid: 0, cashflow: 10, endingBalance: 100, interestShortfall: 0, accumInterestShortfall: 0 },
            { period: 1, paymentDate: "2024-07-15", parCommitment: 100, factor: 1, interestPaid: 10, principalPaid: 0, cashflow: 10, endingBalance: 100, interestShortfall: 0, accumInterestShortfall: 0 },
          ],
        },
      },
    };
    const { paymentHistory } = normalizeSectionResults(sections as never, reportPeriodId, dealId);
    expect(paymentHistory).toHaveLength(1);
  });

  it("preserves zero-amount rows", () => {
    const sections = {
      notes_information: {
        perTranche: {
          "A": [{ period: 1, paymentDate: "2024-07-15", parCommitment: 100, factor: 1, interestPaid: 0, principalPaid: 0, cashflow: 0, endingBalance: 100, interestShortfall: 0, accumInterestShortfall: 0 }],
        },
      },
    };
    const { paymentHistory } = normalizeSectionResults(sections as never, reportPeriodId, dealId);
    expect(paymentHistory).toHaveLength(1);
    expect(paymentHistory[0].interestPaid).toBe(0);
    expect(paymentHistory[0].principalPaid).toBe(0);
  });

  it("returns empty array when notes_information absent", () => {
    const { paymentHistory } = normalizeSectionResults({} as never, reportPeriodId, dealId);
    expect(paymentHistory).toEqual([]);
  });
});
