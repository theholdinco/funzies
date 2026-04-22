import { describe, it, expect } from "vitest";
import { notesInformationSchema } from "../extraction/section-schemas";

describe("notesInformationSchema", () => {
  it("accepts valid per-tranche payment history", () => {
    const input = {
      perTranche: {
        "Sub": [
          { period: 0, paymentDate: "2024-04-17", parCommitment: 33_150_000, factor: 1.0, interestPaid: 0, principalPaid: -31_492_500, cashflow: -31_492_500, endingBalance: 33_150_000, interestShortfall: 0, accumInterestShortfall: 0 },
          { period: 1, paymentDate: "2024-07-15", parCommitment: 33_150_000, factor: 1.0, interestPaid: 0, principalPaid: 0, cashflow: 0, endingBalance: 33_150_000, interestShortfall: 0, accumInterestShortfall: 0 },
        ],
      },
    };
    const parsed = notesInformationSchema.parse(input);
    expect(parsed.perTranche.Sub).toHaveLength(2);
    expect(parsed.perTranche.Sub[0].paymentDate).toBe("2024-04-17");
  });

  it("accepts null numeric fields", () => {
    const input = {
      perTranche: {
        "A": [{
          period: null, paymentDate: "2025-01-15",
          parCommitment: null, factor: null, interestPaid: null, principalPaid: null,
          cashflow: null, endingBalance: null, interestShortfall: null, accumInterestShortfall: null,
        }],
      },
    };
    expect(notesInformationSchema.parse(input).perTranche.A[0].period).toBeNull();
  });

  it("rejects missing paymentDate", () => {
    const input = { perTranche: { "A": [{ period: 1 }] } };
    expect(() => notesInformationSchema.parse(input)).toThrow();
  });
});
