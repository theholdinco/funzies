import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth-helpers";
import { getProfileForUser, getDealForProfile, getLatestReportPeriod, getHoldings, getAccruals } from "@/lib/clo/access";

export async function GET() {
  const user = await getCurrentUser();
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const profile = await getProfileForUser(user.id);
  if (!profile) {
    return NextResponse.json({ holdings: [], accruals: [] });
  }

  const deal = await getDealForProfile((profile as { id: string }).id);
  if (!deal) {
    return NextResponse.json({ holdings: [], accruals: [] });
  }

  const period = await getLatestReportPeriod(deal.id);
  if (!period) {
    return NextResponse.json({ holdings: [], accruals: [] });
  }

  const [holdings, accruals] = await Promise.all([
    getHoldings(period.id),
    getAccruals(period.id),
  ]);
  return NextResponse.json({ holdings, accruals });
}
