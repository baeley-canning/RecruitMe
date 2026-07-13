import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generateOutreachMessage } from "@/lib/ai";
import type { ParsedRole } from "@/lib/ai";
import { safeParseJson } from "@/lib/utils";
import { getAuth, requireCandidateAccess, unauthorized } from "@/lib/session";
import { requireCapability } from "@/lib/require-capability";
import { checkSpendCap } from "@/lib/usage";
import { reportError } from "@/lib/error-reporting";

// If outreach was already drafted within this window, the response includes
// `previouslyDrafted: true` so the UI can warn the recruiter before they
// re-send a near-duplicate message.
const RECENT_OUTREACH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; candidateId: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const denied = await requireCapability(auth, "outreach");
  if (denied) return denied;
  const { id, candidateId } = await params;
  const { job, candidate, error } = await requireCandidateAccess(id, candidateId, auth);
  if (error || !job || !candidate) return error;
  if (!job.parsedRole) {
    return NextResponse.json(
      { error: "Parse the job description first." },
      { status: 400 }
    );
  }
  if (!candidate.profileText) {
    return NextResponse.json(
      { error: "Candidate has no profile text to generate a message from." },
      { status: 400 }
    );
  }

  const spend = await checkSpendCap(auth.orgId);
  if (!spend.allowed) {
    return NextResponse.json(
      { error: `Daily AI spend cap reached ($${spend.spentUsd.toFixed(2)} / $${spend.capUsd.toFixed(2)}). Try again tomorrow or raise AI_DAILY_SPEND_CAP_USD.` },
      { status: 429 },
    );
  }

  try {
    const parsedRole = safeParseJson<ParsedRole | null>(job.parsedRole, null);
    if (!parsedRole) {
      return NextResponse.json({ error: "Job parse data is invalid. Parse the job description again." }, { status: 400 });
    }

    // Look for a recent AI-drafted outreach so we can warn the recruiter
    // before they re-generate (and risk sending a near-duplicate).
    const recent = await prisma.contactEvent.findFirst({
      where: {
        candidateId,
        type: "ai_outreach_generated",
        createdAt: { gt: new Date(Date.now() - RECENT_OUTREACH_WINDOW_MS) },
      },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, userName: true },
    });

    const message = await generateOutreachMessage(
      candidate.profileText,
      parsedRole,
      candidate.name,
      { orgId: auth.orgId, userId: auth.userId },
    );

    // Log this generation as a contact event so it shows on the candidate
    // card and feeds the recruiter's "did I already reach out?" instinct.
    const user = await prisma.user.findUnique({ where: { id: auth.userId }, select: { username: true } });
    await prisma.contactEvent.create({
      data: {
        candidateId,
        orgId:    auth.orgId,
        userId:   auth.userId,
        userName: user?.username ?? auth.userId,
        type:     "ai_outreach_generated",
        note:     "AI outreach message drafted",
      },
    }).catch(() => { /* non-fatal — don't fail the response over a log write */ });

    return NextResponse.json({
      ...message,
      previouslyDrafted: Boolean(recent),
      previousDraft: recent ? { at: recent.createdAt.toISOString(), by: recent.userName } : undefined,
    });
  } catch (err) {
    reportError(err, { route: "outreach:generate", jobId: id, candidateId, orgId: auth.orgId });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Generation failed" },
      { status: 500 }
    );
  }
}
