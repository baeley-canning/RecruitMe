import { NextResponse } from "next/server";
import { generateJobAd } from "@/lib/ai";
import type { ParsedRole } from "@/lib/ai";
import { safeParseJson } from "@/lib/utils";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";
import { requireCapability } from "@/lib/require-capability";
import { checkSpendCap } from "@/lib/usage";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const denied = await requireCapability(auth, "outreach");
  if (denied) return denied;
  const { id } = await params;
  const { job, error } = await requireJobAccess(id, auth);
  if (error || !job) return error;

  const parsedRole = safeParseJson<ParsedRole | null>(job.parsedRole, null);
  if (!parsedRole) return NextResponse.json({ error: "Job not parsed yet — parse it first" }, { status: 422 });

  const spend = await checkSpendCap(auth.orgId);
  if (!spend.allowed) {
    return NextResponse.json(
      { error: `Daily AI spend cap reached ($${spend.spentUsd.toFixed(2)} / $${spend.capUsd.toFixed(2)}). Try again tomorrow or raise AI_DAILY_SPEND_CAP_USD.` },
      { status: 429 },
    );
  }

  const ad = await generateJobAd(parsedRole, job.company, job.rawJd, { orgId: auth.orgId, userId: auth.userId });
  return NextResponse.json(ad);
}
