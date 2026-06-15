import { extensionCorsHeaders } from "@/lib/extension-cors";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  applyAiEnrichmentInBackground,
  findSessionInQueue,
  linkedInProfileMatches,
  saveCapturedProfileFast,
  updateSessionInQueue,
} from "@/lib/linkedin-capture";
import { isLinkedInProfileUrl } from "@/lib/linkedin";
import { verifyExtensionAuth } from "@/lib/session";
import { checkRateLimit, recordUsage } from "@/lib/usage";
import { reportError } from "@/lib/error-reporting";

// Stage 1 (saveCapturedProfileFast) is synchronous and bounded — but the
// extension can post a 100KB profile and the DB write + identity hashing
// occasionally spikes past the default function timeout. Lift to 60s so the
// 202 always lands, leaving Stage 2 (background scoring) to run after.
export const maxDuration = 60;

// EXTENSION_CORS headers are computed per-request to restrict to extension origins

const BodySchema = z.object({
  sessionId: z.string().min(1),
  linkedinUrl: z.string().url().max(500).refine(isLinkedInProfileUrl, {
    message: "linkedinUrl must be a linkedin.com/in/<slug> URL",
  }),
  profileText: z.string().min(100).max(100_000),
  // Extension-emitted proof of deep-page usage; opaque JSON, see import route.
  captureMeta: z.unknown().optional(),
});

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: extensionCorsHeaders(req) });
}

// Stage 2 of the capture pipeline. Runs as a fire-and-forget background
// Promise after the response goes out — so the recruiter never has to keep
// the page open for scoring to finish.
async function processBackgroundScoring(args: {
  sessionId: string;
  candidateId: string;
  identity: Awaited<ReturnType<typeof saveCapturedProfileFast>>["identity"];
}) {
  const { sessionId, candidateId, identity } = args;
  try {
    const { applied } = await applyAiEnrichmentInBackground(candidateId, identity);
    // Stage 2 may legitimately not apply for two reasons — both end as
    // "completed" from the recruiter's perspective:
    //   1. profileTextHash changed (recruiter manually re-scored in between),
    //   2. candidate row was deleted before stage 2 landed.
    // Stage 1 already persisted profileText to whatever row existed, so the
    // user-facing fact "profile captured" is true either way. Use a neutral
    // message rather than claiming the score was applied when it wasn't.
    await updateSessionInQueue({
      sessionId,
      status: "completed",
      message: applied ? "Profile captured and scored" : "Profile captured",
      completedAt: new Date().toISOString(),
    });
  } catch (err) {
    // Stage 1 already persisted profileText, so the candidate is "captured"
    // even if scoring fails. Mark the session errored so the polling UI
    // surfaces the failure and the recruiter can manually re-score.
    const message = err instanceof Error ? err.message : "Scoring failed";
    await updateSessionInQueue({
      sessionId,
      status: "error",
      message: `Captured but scoring failed: ${message}`,
      error: message,
    });
  }
}

export async function POST(req: Request) {
  // AUTH: without this anyone could write profileText into any session by
  // guessing a sessionId, poisoning the candidate row before AI scoring runs.
  const auth = await verifyExtensionAuth(req);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: extensionCorsHeaders(req) });
  }

  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422, headers: extensionCorsHeaders(req) });
  }

  const { sessionId, linkedinUrl, profileText, captureMeta } = parsed.data;
  const session = await findSessionInQueue((s) => s.sessionId === sessionId);

  if (!session) {
    return NextResponse.json({ error: "No matching capture session" }, { status: 404, headers: extensionCorsHeaders(req) });
  }

  // Caller must own the session or be a platform owner. Sessions with an
  // orgId set are never writable cross-org; truly legacy sessions (no userId
  // AND no orgId) remain accepted so existing rows aren't orphaned.
  const sameUser = Boolean(session.userId) && session.userId === auth.userId;
  const sameOrg  = Boolean(session.orgId && auth.orgId && session.orgId === auth.orgId);
  const legacy   = !session.userId && !session.orgId;
  if (!auth.isOwner && !sameUser && !sameOrg && !legacy) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: extensionCorsHeaders(req) });
  }

  if (!linkedInProfileMatches(session.linkedinUrl, linkedinUrl)) {
    await updateSessionInQueue({
      sessionId,
      status: "error",
      message: "Captured profile URL did not match the pending candidate",
      error: "linkedin_url_mismatch",
    });
    return NextResponse.json({ error: "LinkedIn URL mismatch" }, { status: 409, headers: extensionCorsHeaders(req) });
  }

  // STAGE 1 — fast persist. Saves profileText, identity, profileTextHash
  // synchronously before we return the 202. After this point the candidate
  // row in the DB is "captured" and any subsequent page load shows it as
  // such, regardless of whether the recruiter is still on the original
  // /jobs/[id] tab. This is the fix for the "capture only saves when I
  // return to the page" bug.
  let identity;
  try {
    const fast = await saveCapturedProfileFast({
      jobId: session.jobId,
      candidateId: session.candidateId,
      linkedinUrl,
      profileText,
      captureMeta,
    });
    identity = fast.identity;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save captured profile";
    await updateSessionInQueue({ sessionId, status: "error", message, error: message });
    return NextResponse.json({ error: message }, { status: 500, headers: extensionCorsHeaders(req) });
  }

  // Per-org rate limit on the AI-scoring stage. The capture itself is already
  // persisted above (the valuable part), so a rate-limited capture is kept, not
  // lost — we only skip the expensive Claude scoring. Without this gate a
  // compromised extension credential could create+complete sessions in a loop
  // and drive unbounded AI spend (the /api/extension/import route gates the
  // same way). recordUsage also closes the usage-ledger gap on this path.
  const rateCheck = await checkRateLimit(auth.orgId, "capture");
  if (!rateCheck.allowed) {
    await updateSessionInQueue({
      sessionId,
      status: "completed",
      message: "Profile captured — scoring skipped (rate limit reached)",
      completedAt: new Date().toISOString(),
    });
    return NextResponse.json(
      {
        accepted: true,
        sessionId,
        status: "completed",
        message: "Profile captured — scoring skipped (rate limit reached)",
      },
      { status: 202, headers: extensionCorsHeaders(req) },
    );
  }
  void recordUsage(auth.orgId, auth.userId, "capture", { sessionId, source: "extension_fetch_session" });

  await updateSessionInQueue({
    sessionId,
    status: "processing",
    message: "Profile captured — scoring with AI",
  });

  // STAGE 2 — fire-and-forget AI scoring. The candidate is already saved;
  // this just patches in the score fields when Claude returns. If it fails,
  // the candidate stays captured-but-unscored and the session is marked
  // errored so the recruiter can re-score manually.
  processBackgroundScoring({ sessionId, candidateId: session.candidateId, identity }).catch((err) => {
    reportError(err, { route: "extension/fetch-session/complete", sessionId, candidateId: session.candidateId });
  });

  return NextResponse.json(
    {
      accepted: true,
      sessionId,
      status: "processing",
      message: "Profile captured — scoring with AI",
    },
    { status: 202, headers: extensionCorsHeaders(req) }
  );
}
