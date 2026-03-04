export interface DateAuthority {
  field: string;
  ppmValue: string | null;
  complianceValue: string | null;
  resolvedValue: string | null;
  source: "ppm" | "compliance" | "none";
  reason: string;
}

export interface DateReconciliationResult {
  isRefinanced: boolean;
  authorities: DateAuthority[];
  resolvedDates: Record<string, string | null>;
}

interface DateInputs {
  ppmDates: Record<string, string | null>;
  complianceDates: Record<string, string | null>;
}

const DATE_AUTHORITY: Record<string, "ppm" | "compliance" | "ppm_only" | "compliance_only"> = {
  closing_date: "compliance",
  effective_date: "compliance",
  current_issue_date: "ppm_only",
  reinvestment_period_end: "ppm",
  non_call_period_end: "ppm_only",
  stated_maturity_date: "ppm",
  first_payment_date: "ppm_only",
  payment_frequency: "ppm",
  report_date: "compliance_only",
  payment_date: "compliance_only",
};

function parseYear(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const m = dateStr.match(/(\d{4})/);
  return m ? parseInt(m[1]) : null;
}

function detectRefinancing(ppmDates: Record<string, string | null>, complianceDates: Record<string, string | null>): boolean {
  const currentIssue = ppmDates.current_issue_date;
  const closing = complianceDates.closing_date ?? ppmDates.closing_date;

  if (!currentIssue || !closing) return false;

  const issueYear = parseYear(currentIssue);
  const closingYear = parseYear(closing);
  if (!issueYear || !closingYear) return false;

  return issueYear > closingYear || (issueYear === closingYear && currentIssue > closing);
}

export function reconcileDates(inputs: DateInputs): DateReconciliationResult {
  const { ppmDates, complianceDates } = inputs;
  const isRefinanced = detectRefinancing(ppmDates, complianceDates);
  const authorities: DateAuthority[] = [];
  const resolvedDates: Record<string, string | null> = {};

  for (const [field, authority] of Object.entries(DATE_AUTHORITY)) {
    const ppmVal = ppmDates[field] ?? null;
    const complianceVal = complianceDates[field] ?? null;

    let resolvedValue: string | null = null;
    let source: "ppm" | "compliance" | "none" = "none";
    let reason = "";

    switch (authority) {
      case "ppm_only":
        resolvedValue = ppmVal;
        source = ppmVal ? "ppm" : "none";
        reason = ppmVal ? "PPM-only field" : "not available in either source";
        break;

      case "compliance_only":
        resolvedValue = complianceVal;
        source = complianceVal ? "compliance" : "none";
        reason = complianceVal ? "compliance-only field" : "not available in either source";
        break;

      case "ppm":
        if (ppmVal) {
          resolvedValue = ppmVal;
          source = "ppm";
          reason = "PPM authoritative for this field";
          if (complianceVal && complianceVal !== ppmVal) {
            reason += ` (compliance has ${complianceVal} — ${isRefinanced ? "stale pre-refinancing value" : "differs"})`;
          }
        } else if (complianceVal) {
          resolvedValue = complianceVal;
          source = "compliance";
          reason = "PPM missing, using compliance as fallback";
        } else {
          reason = "not available in either source";
        }
        break;

      case "compliance":
        if (complianceVal) {
          resolvedValue = complianceVal;
          source = "compliance";
          reason = "compliance authoritative for this field";
        } else if (ppmVal) {
          resolvedValue = ppmVal;
          source = "ppm";
          reason = "compliance missing, using PPM as fallback";
        } else {
          reason = "not available in either source";
        }
        break;
    }

    authorities.push({ field, ppmValue: ppmVal, complianceValue: complianceVal, resolvedValue, source, reason });
    resolvedDates[field] = resolvedValue;

    if (ppmVal && complianceVal && ppmVal !== complianceVal) {
      console.log(`[date-reconciler] CONFLICT ${field}: PPM=${ppmVal} vs Compliance=${complianceVal} → resolved to ${resolvedValue} (${reason})`);
    }
  }

  console.log(`[date-reconciler] refinanced=${isRefinanced}, resolved ${Object.values(resolvedDates).filter(Boolean).length}/${Object.keys(DATE_AUTHORITY).length} dates`);

  return { isRefinanced, authorities, resolvedDates };
}
