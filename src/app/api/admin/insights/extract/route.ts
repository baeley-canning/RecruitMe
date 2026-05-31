/**
 * Admin route for triggering a ProfileInsight extraction for a single
 * CandidateIdentity. Used by:
 *   • scripts/backfill-insights.mjs (orchestrator that walks the queue)
 *   • A future UI "extract now" button on /admin
 *
 * Idempotency: saveInsight is keyed on
 * (orgId, identityId, sourceProfileTextHash, extractionVersion) — re-calling
 * this endpoint for the same identity with unchanged profileText is a
 * no-op upsert that returns the existing row. Safe to retry.
 *
 * Auth (BOTH paths accepted):
 *   • Owner-authenticated session (auth.isOwner === true), OR
 *   • x-cron-secret header matching CONTACT_SYNC_CRON_SECRET (timing-safe).
 *     This mirrors the auth shape used by purge-jobadder-imports — see
 *     src/app/api/admin/purge-jobadder-imports/route.ts.
 *
 * Cost: one Claude/Ollama call per identity unless the profileText is
 * < INSIGHT_MIN_PROFILE_CHARS, in which case the extractor returns a
 * thin-profile stub without spending tokens. Both paths cost-track via
 * recordAiCall (the underlying chat helper) so they appear in UsageEvent.
 *
 * Rate limit: callers should hit checkRateLimit("insight_extract") OR
 * tolerate the daily/hourly burst limit this route enforces via the
 * usage layer indirectly (extractor → chatWithFailover → recordAiCall →
 * counted in UsageEvent under type "ai_call" not "insight_extract").
 * That gap is intentional for now — backfill script enforces its own
 * pacing.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { timingSafeEqual } from "crypto";
import { prisma } from "@/lib/db";
import { getAuth } from "@/lib/session";
import { extractInsight } from "@/lib/ai/insights";
import { saveInsight } from "@/lib/insight-cache";
import { sanitiseProfileTextForInsight } from "@/lib/profile-text-sanitiser";
import { isProfileInsightWriteEnabled } from "@/lib/feature-flags";

const BodySchema = z.object({
  identityId: z.string().min(1),
});

function checkCronSecret(req: Request): boolean {
  const provided = req.headers.get("x-cron-secret");
  const expected = process.env.CONTACT_SYNC_CRON_SECRET;
  if (!provided || !expected) return false;
  // Timing-safe comparison — same pattern as purge-jobadder-imports.
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  // Feature flag — the write path stays dormant until rollout. Mirrors
  // the gating on identity merge routes (RECRUITME_IDENTITY_MERGE_UI_ENABLED).
  if (!isProfileInsightWriteEnabled()) {
    return NextResponse.json(
      { error: "ProfileInsight write path is not enabled in this environment." },
      { status: 404 },
    );
  }

  const cronOk = checkCronSecret(req);
  const auth = cronOk ? null : await getAuth();
  const isAuthorized = cronOk || Boolean(auth?.isOwner);
  if (!isAuthorized) {
    return NextResponse.json({ error: "Forbidden — owner or cron-secret required." }, { status: 403 });
  }

  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });
  }
  const { identityId } = parsed.data;

  // Load identity + all its candidates' profileText so we can pick the
  // longest one to extract from. Identity row has orgId; candidates are
  // already org-scoped via the schema's @@unique([orgId, ...]).
  const identity = await prisma.candidateIdentity.findUnique({
    where: { id: identityId },
    select: {
      id: true,
      orgId: true,
      candidates: {
        select: { id: true, profileText: true },
        where: { profileText: { not: null } },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  if (!identity) {
    return NextResponse.json({ error: "Identity not found." }, { status: 404 });
  }

  // Pick the longest profileText across all candidate rows for this
  // identity. Same heuristic the audit script uses — the longest text
  // is the recruiter's best capture of this person.
  const longest = identity.candidates.reduce(
    (acc, c) => {
      const len = (c.profileText ?? "").length;
      return len > acc.len ? { text: c.profileText ?? "", len, id: c.id } : acc;
    },
    { text: "", len: 0, id: null as string | null },
  );

  if (!longest.text || longest.len === 0) {
    return NextResponse.json(
      { action: "skipped", reason: "no_profile_text", identityId },
      { status: 200 },
    );
  }

  // Sanitise BEFORE extraction — drops recruiter notes / screening data
  // from the AI's view so evidenceSnippets can't leak them.
  const { sanitised, droppedLines } = sanitiseProfileTextForInsight(longest.text);

  // Extract — calls chatWithFailover internally, costs ~$0.005 typically,
  // returns thin-profile stub for <500 char inputs without spending tokens.
  const extracted = await extractInsight({
    profileText: sanitised,
    orgId: identity.orgId,
    userId: auth?.userId ?? null,
  });

  // Persist — idempotent on (orgId, identityId, hash, version). Marks any
  // prior current row as superseded; updates CandidateIdentity.currentInsightId.
  const saved = await saveInsight({
    orgId: identity.orgId,
    identityId,
    extracted,
    sourceCandidateId: longest.id ?? undefined,
  });

  return NextResponse.json({
    action: "extracted",
    identityId,
    insightId: saved.id,
    extractedBy: extracted.extractedBy,
    modelId: extracted.modelId,
    sourceProfileTextHash: extracted.sourceProfileTextHash,
    extractionVersion: extracted.extractionVersion,
    sanitisationDroppedLines: droppedLines,
    thinProfile: Boolean(extracted.facts.thinProfile),
  });
}
