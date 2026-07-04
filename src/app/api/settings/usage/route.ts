/**
 * GET /api/settings/usage — the caller's org AI usage & cost summary.
 *
 * Org-scoped: reads only the caller's orgId ledger. An owner with no home org
 * gets an empty summary (nothing to bill). ?days=N narrows the window (1..120).
 */

import { NextResponse } from "next/server";
import { getAuth, unauthorized } from "@/lib/session";
import { getOrgUsageSummary } from "@/lib/usage-summary";
import { parseIntParam } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  if (!auth.orgId) {
    return NextResponse.json({
      orgId: null,
      windowDays: 30,
      totalCostUsd: 0,
      totalAiCalls: 0,
      last24hCostUsd: 0,
      last24hAiCalls: 0,
      dailyCapUsd: 0,
      capUsedFraction: 0,
      daily: [],
      byType: [],
    });
  }
  const days = parseIntParam(new URL(req.url).searchParams.get("days"), { min: 1, max: 120, default: 30 });
  const summary = await getOrgUsageSummary(auth.orgId, days);
  return NextResponse.json(summary);
}
