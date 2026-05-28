import { NextResponse } from "next/server";
import { getAuth, unauthorized } from "@/lib/session";
import { computeMarketIntelligence, computeSkillTrendsFromPlacements } from "@/lib/market-trends";

export async function GET() {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  if (!auth.orgId) return NextResponse.json({ error: "No organisation" }, { status: 400 });

  const [intelligence, placementTrends] = await Promise.all([
    computeMarketIntelligence(auth.orgId),
    computeSkillTrendsFromPlacements(auth.orgId),
  ]);

  return NextResponse.json({ ...intelligence, placementTrends });
}
