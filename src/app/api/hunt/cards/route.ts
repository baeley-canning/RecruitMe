/**
 * Score a page of hunt results.
 *
 * The extension sends the cards it read off a LinkedIn people-search page. This
 * endpoint says what they are worth and which ones we already have. It is
 * deliberately READ-ONLY: nothing is written to the library here. The recruiter
 * sees the ranked list first and chooses what to keep, which is the whole point
 * of a tool that runs in their own browser rather than a bot that decides for
 * them.
 *
 * Scoring is the deterministic base score — the SAME buildProvisionalSearchScore
 * the in-app search import uses (via baseScoreUpdateData), so a candidate ranks
 * identically whether they arrived through a hunt, a search run, or were sitting
 * in the library already. No AI, no spend, no cache invalidation: a hunt costs
 * nothing but the recruiter's own browsing.
 *
 * The card text is attacker-controlled — a headline can say anything a
 * candidate wants it to. That is safe here precisely because nothing on this
 * path asks a language model to DECIDE anything: the text is matched against
 * the role's requirements by pure code. Keep it that way.
 */
import { extensionCorsHeaders } from "@/lib/extension-cors";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { verifyExtensionAuth } from "@/lib/session";
import { reportError } from "@/lib/error-reporting";
import { normaliseLinkedInUrl } from "@/lib/linkedin";
import { locationMatches } from "@/lib/nz-locations";
import { baseScoreUpdateData } from "@/lib/base-score";
import { getJobScoringWeights } from "@/lib/scoring-config";
import type { ParsedRole } from "@/lib/ai";

export const maxDuration = 60;

const CardSchema = z.object({
  url: z.string().url().max(500),
  name: z.string().min(1).max(120),
  headline: z.string().max(500).nullable().optional(),
  location: z.string().max(200).nullable().optional(),
});

const BodySchema = z.object({
  jobId: z.string().min(1),
  // One results page is ~10 cards; 100 is a generous ceiling that still bounds
  // the work a single request can ask for.
  cards: z.array(CardSchema).min(1).max(100),
  /**
   * Region to narrow to, e.g. "Wellington". Filtering happens HERE rather than
   * by driving LinkedIn's own location filter: a transcript of Claude-in-Chrome
   * notes that pressing Enter in that filter can close it without applying,
   * which would silently return nationwide results that look correct. We hold
   * the card's location string, so this is testable server-side instead.
   */
  location: z.string().max(120).nullable().optional(),
});

function safeParseRole(raw: string | null): ParsedRole | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ParsedRole;
  } catch {
    return null;
  }
}

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: extensionCorsHeaders(req) });
}

export async function POST(req: Request) {
  const auth = await verifyExtensionAuth(req);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: extensionCorsHeaders(req) });
  }

  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422, headers: extensionCorsHeaders(req) });
  }

  const job = await prisma.job.findUnique({ where: { id: parsed.data.jobId } });
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404, headers: extensionCorsHeaders(req) });
  }
  if (!auth.isOwner && job.orgId !== auth.orgId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: extensionCorsHeaders(req) });
  }

  const role = safeParseRole(job.parsedRole);
  if (!role) {
    return NextResponse.json(
      { error: "This job has not been analysed yet — open it in RecruitMe and press Re-analyse first." },
      { status: 409, headers: extensionCorsHeaders(req) },
    );
  }

  // Normalise first so two spellings of the same profile collapse before we
  // hit the database, and so the dedupe lookup matches what ingestion stores.
  const wantedLocation = (parsed.data.location ?? "").trim() || null;
  const allCards = parsed.data.cards.map((c) => ({ ...c, url: normaliseLinkedInUrl(c.url) || c.url }));
  // Narrow to the requested region. locationMatches drops cards with no
  // location when a region IS selected — the same rule the in-app library
  // search uses, so a hunt and a library search agree about who is "in
  // Wellington".
  const cards = wantedLocation ? allCards.filter((c) => locationMatches(c.location, wantedLocation)) : allCards;
  const byUrl = new Map<string, (typeof cards)[number]>();
  for (const c of cards) if (!byUrl.has(c.url)) byUrl.set(c.url, c);
  const urls = [...byUrl.keys()];

  // Dedupe against the library, ORG-SCOPED. A candidate row is visible when its
  // job belongs to an accessible org, or it is a library-only row (jobId null)
  // whose own orgId matches — the same predicate the rest of the app uses.
  const orgFilter = auth.isOwner
    ? {}
    : { OR: [{ job: { orgId: auth.orgId } }, { jobId: null, orgId: auth.orgId }] };

  let known: Array<{
    id: string;
    linkedinUrl: string | null;
    profileText: string | null;
    jobId: string | null;
    matchScore: number | null;
  }> = [];
  try {
    known = await prisma.candidate.findMany({
      where: { linkedinUrl: { in: urls }, ...orgFilter },
      select: { id: true, linkedinUrl: true, profileText: true, jobId: true, matchScore: true },
      orderBy: { profileCapturedAt: "desc" },
    });
  } catch (err) {
    reportError(err, { route: "hunt/cards", orgId: auth.orgId ?? undefined });
  }

  // Prefer the richest row we hold for a person — the one with profile text.
  const bestByUrl = new Map<string, (typeof known)[number]>();
  for (const k of known) {
    const key = k.linkedinUrl ? normaliseLinkedInUrl(k.linkedinUrl) || k.linkedinUrl : null;
    if (!key) continue;
    const prev = bestByUrl.get(key);
    if (!prev || ((k.profileText?.length ?? 0) > (prev.profileText?.length ?? 0))) bestByUrl.set(key, k);
  }

  const weights = await getJobScoringWeights(job.scoringWeights, job.orgId).catch(() => undefined);

  const results = [...byUrl.values()].map((card) => {
    const hit = bestByUrl.get(card.url) ?? null;
    // Score on the best evidence we have: the stored profile text when we hold
    // it, otherwise the card's own headline. The breakdown records which, so a
    // 40-from-a-headline is never mistaken for a 40-from-a-CV.
    const evidenceText = hit?.profileText ?? null;
    const scored = baseScoreUpdateData(
      { name: card.name, headline: card.headline ?? null, location: card.location ?? null, evidenceText },
      { location: job.location, location2: job.location2, isRemote: job.isRemote },
      role,
      weights,
    );
    return {
      url: card.url,
      name: card.name,
      headline: card.headline ?? null,
      location: card.location ?? null,
      /** Already in this org's library. */
      known: Boolean(hit),
      candidateId: hit?.id ?? null,
      /** Already attached to THIS job — no point re-adding. */
      onThisJob: hit?.jobId === job.id,
      /** True when opening the profile would actually teach us something. */
      needsCapture: !evidenceText,
      evidence: evidenceText ? "profile" : "headline",
      fit: scored.matchScore,
      reason: scored.matchReason,
    };
  });

  // Rank: best fit first, but a row we can only judge from a headline never
  // outranks one judged on a real profile at the same score — otherwise a
  // confident-sounding headline beats a candidate we actually know.
  results.sort((a, b) => b.fit - a.fit || Number(b.evidence === "profile") - Number(a.evidence === "profile"));

  return NextResponse.json(
    {
      jobId: job.id,
      received: parsed.data.cards.length,
      location: wantedLocation,
      droppedByLocation: allCards.length - cards.length,
      deduped: results.length,
      alreadyKnown: results.filter((r) => r.known).length,
      results,
    },
    { headers: extensionCorsHeaders(req) },
  );
}
