/**
 * Browse the org's candidate library scoped to a specific job — returns all
 * library candidates with full profileText, EXCLUDING those already imported
 * into this job. Used by the "Browse library" modal to manually pick people
 * to add to the job (Q2.1: candidate library as first-class search target).
 *
 * The existing /api/jobs/[id]/candidates/talent-pool route does keyword-based
 * automatic matching; this is the manual-pick equivalent so the recruiter
 * can choose specific candidates.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { scoreCandidateStructured } from "@/lib/ai";
import type { ParsedRole } from "@/lib/ai";
import { applyLocationFitOverride, deriveUpdateData } from "@/lib/score-utils";
import { getJobTargetLocation } from "@/lib/job-target-location";
import { enrichCandidateInBackground } from "@/lib/firmable-enrich";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";
import { safeParseJson, buildScoreCacheKey } from "@/lib/utils";
import { getJobScoringWeights } from "@/lib/scoring-config";
import { getAccessibleOrgIds, candidateOrgFilter } from "@/lib/org-access";
import { shouldRejectAsOverseas } from "@/lib/location";
import { checkRateLimit, checkSpendCap } from "@/lib/usage";

// Library POST scores N candidates × 2 (score + acceptance) with retry. At the
// 50-candidate Zod cap and ~3-5s per Claude call, a sequential run could
// linger near 5 minutes. The new CONCURRENCY=3 pattern brings worst-case to
// ~90s — comfortably under the 120s budget below.
export const maxDuration = 120;

const POST_CONCURRENCY = 3;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;

  const { error } = await requireJobAccess(id, auth);
  if (error) return error;

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const limit = Math.min(200, Math.max(10, Number(url.searchParams.get("limit") ?? 50)));
  // SQL `take` previously hard-coded 500 regardless of ?limit=. For small
  // limit= requests this dragged the whole 500-row dedupe loop through Node
  // memory just to slice down to (say) 25 rows. Honour the caller's cap
  // here, but stay generous (4× requested) so post-filter dedupe + the
  // already-imported exclusion still has a buffer of rows to work from.
  const prismaTake = Math.min(500, Math.max(limit * 4, limit));

  // URLs already imported into this job — used as a filter to exclude duplicates.
  const existing = await prisma.candidate.findMany({
    where: { jobId: id },
    select: { linkedinUrl: true },
  });
  const existingUrls = new Set(
    existing.map((c) => c.linkedinUrl?.toLowerCase()).filter(Boolean) as string[]
  );

  // Library scope: caller's own org plus any orgs the caller has been granted
  // library_read access to (cross-org subscription). Owner sees all.
  const accessibleOrgIds = await getAccessibleOrgIds(auth);
  const candidates = await prisma.candidate.findMany({
    where: {
      profileText: { not: null },
      ...candidateOrgFilter(accessibleOrgIds),
      // Push the search query to SQL. Without this, the previous JS-side
      // filter only saw the 500 newest rows — after the JobAdder bulk
      // import all 500 collapsed to today's imports, so any query for a
      // candidate created earlier than the import returned 0 hits even
      // though they were in the library. Doing it in Postgres means
      // "Library is large" no longer hides older relevant people.
      ...(q ? {
        OR: [
          { name:     { contains: q, mode: "insensitive" } },
          { headline: { contains: q, mode: "insensitive" } },
          { location: { contains: q, mode: "insensitive" } },
        ],
      } : {}),
    },
    // id-desc tiebreaker against bulk-insert timestamp collisions.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: prismaTake, // honours ?limit= with a 4× buffer for dedupe
    select: {
      id: true,
      name: true,
      headline: true,
      location: true,
      linkedinUrl: true,
      matchScore: true,
      createdAt: true,
      job: { select: { title: true } },
      archivedJobTitle: true,
    },
  });

  // De-duplicate by linkedinUrl — the same person across multiple jobs only
  // shows once (the most recent row wins). Query string `q` is now applied
  // at SQL above so the JS filter no longer re-checks it.
  const seenUrls = new Set<string>();
  const filtered = candidates.filter((c) => {
    if (c.linkedinUrl && existingUrls.has(c.linkedinUrl.toLowerCase())) return false;
    if (c.linkedinUrl) {
      const key = c.linkedinUrl.toLowerCase();
      if (seenUrls.has(key)) return false;
      seenUrls.add(key);
    }
    return true;
  }).slice(0, limit);

  return NextResponse.json({ candidates: filtered, total: filtered.length });
}

const PostSchema = z.object({
  candidateIds: z.array(z.string()).min(1).max(50),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;

  const { job, error } = await requireJobAccess(id, auth);
  if (error || !job) return error;

  // Library import does scoring + (optional) Firmable enrichment per row, up
  // to the 50-candidate Zod cap below. Same per-org rate limit + daily USD
  // cap as score-all so a single click can't blow past the $5/day budget.
  // Mirrors the guard pattern in score-all/route.ts:34-48.
  const rateCheck = await checkRateLimit(auth.orgId, "score");
  if (!rateCheck.allowed) {
    const waitMin = Math.ceil((rateCheck.retryAfterMs ?? 60000) / 60000);
    return NextResponse.json({ error: `Scoring rate limit reached. Try again in ~${waitMin} minute${waitMin !== 1 ? "s" : ""}.` }, { status: 429 });
  }
  const spend = await checkSpendCap(auth.orgId);
  if (!spend.allowed) {
    return NextResponse.json({
      error: `Daily AI spend cap reached ($${spend.spentUsd.toFixed(2)} / $${spend.capUsd.toFixed(2)}). Try again tomorrow or raise AI_DAILY_SPEND_CAP_USD.`,
    }, { status: 429 });
  }

  const parsed = PostSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });
  }

  const parsedRole = safeParseJson<ParsedRole | null>(job.parsedRole, null);
  if (!parsedRole) {
    return NextResponse.json({ error: "Analyse the job description first." }, { status: 400 });
  }

  const salary = (job.salaryMin || job.salaryMax)
    ? { min: job.salaryMin ?? 0, max: job.salaryMax ?? 0 }
    : null;
  const weights = await getJobScoringWeights(job.scoringWeights, auth.orgId);

  // Pull source candidates with full profile text — same library scope as
  // GET (own org + granted-access orgs). Owner bypasses.
  //
  // CHARS_MIN gate: Prisma's `profileText: { not: null }` matches the empty
  // string too, so library rows that were JobAdder-imported but never had a
  // CV extracted (no CandidateFile → extract-cv-text couldn't run) would
  // land here with profileText="" and import with zero content. The strict
  // talent-pool route uses hasReusablePoolProfile / hasFullCandidateProfile
  // for this; mirror it at the SQL level with a length predicate so the
  // modal-driven path can't smuggle in empty-profile candidates either.
  const accessibleOrgIds = await getAccessibleOrgIds(auth);
  const PROFILE_MIN_CHARS = 500; // matches CAPTURED_PROFILE_MIN_CHARS in candidate-profile.ts
  const sourceCandidatesRaw = await prisma.candidate.findMany({
    where: {
      id: { in: parsed.data.candidateIds },
      profileText: { not: null },
      ...candidateOrgFilter(accessibleOrgIds),
    },
  });
  const sourceCandidates = sourceCandidatesRaw.filter(
    (c) => (c.profileText?.trim().length ?? 0) >= PROFILE_MIN_CHARS,
  );
  const skippedEmpty = sourceCandidatesRaw.length - sourceCandidates.length;
  if (skippedEmpty > 0) {
    console.log(`[library-import] skipped ${skippedEmpty} library row(s) with profileText < ${PROFILE_MIN_CHARS} chars`);
  }

  let added = 0;
  const failed: string[] = [];
  const unscoredIds: string[] = []; // imported but scoring failed after retry
  const skippedOverseas: string[] = [];

  // Process each candidate in parallel chunks of POST_CONCURRENCY. Previously
  // sequential — at the 50-candidate Zod cap that meant 50 × ~5s = ~4 min,
  // routinely blowing past Vercel's response budget and leaving the
  // recruiter staring at a hung modal. CONCURRENCY=3 (the same value
  // score-all uses) keeps wall time under the 120s maxDuration ceiling
  // without saturating the Anthropic rate limiter.
  const processOne = async (source: typeof sourceCandidates[number]) => {
    if (!source.profileText) return;
    // Country gate: never import a confirmed-overseas candidate onto a
    // non-remote NZ role. shouldRejectAsOverseas combines explicit-location
    // check with profile-text inference (Present-role location, "based in"
    // phrases, definitely-overseas current employer, +64/+61 phone codes)
    // and applies a two-signal requirement so returnee Kiwis whose profile
    // mentions e.g. London past roles aren't false-positively rejected.
    const overseas = shouldRejectAsOverseas({
      explicitLocation: source.location,
      headline: source.headline,
      profileText: source.profileText,
      isRemote: job.isRemote,
    });
    if (overseas.reject) {
      skippedOverseas.push(source.id);
      return;
    }

    // Try scoring twice — transient API failures (timeouts, 503s) are common
    // and a single retry catches most of them without significant latency.
    let breakdown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await scoreCandidateStructured(source.profileText, parsedRole, salary, weights, auth.orgId);
        breakdown = applyLocationFitOverride(raw, source.location, getJobTargetLocation(job, parsedRole), parsedRole.location_rules, job.isRemote, weights);
        break;
      } catch {
        if (attempt === 0) await new Promise((r) => setTimeout(r, 800));
      }
    }

    try {
      // For library candidates with no real LinkedIn URL, synthesise a stable
      // key from source.id and store it as the linkedinUrl too — otherwise
      // re-importing the same source-row produces a duplicate, because the
      // unique constraint sees `library:src-1` in the where but `null` in the
      // create row, so the upsert never finds a match.
      const linkedinUrl = source.linkedinUrl ?? `library:${source.id}`;
      const upserted = await prisma.candidate.upsert({
        where: { jobId_linkedinUrl: { jobId: id, linkedinUrl } },
        create: {
          jobId: id,
          orgId: job.orgId ?? null,
          name: source.name,
          headline: source.headline,
          location: source.location,
          linkedinUrl,
          profileText: source.profileText,
          source: "talent_pool",
          status: "new",
          profileCapturedAt: source.profileCapturedAt,
          // If scoring succeeded, spread score data + hash; otherwise import
          // without a score so the candidate is visible and can be re-scored.
          ...(breakdown ? deriveUpdateData(breakdown) : {}),
          ...(breakdown ? {
            profileTextHash: buildScoreCacheKey({ profileText: source.profileText, parsedRole, salary, jobLocation: job.location, jobLocation2: job.location2, isRemote: job.isRemote, weights }),
          } : {}),
        },
        update: {
          ...(breakdown ? deriveUpdateData(breakdown) : {}),
        },
      });
      added++;
      // Background phone enrichment — gated by Firmable's 90d cache so
      // re-importing the same person to a new job doesn't re-bill.
      enrichCandidateInBackground(upserted.id);
      if (!breakdown) unscoredIds.push(source.id);
    } catch {
      failed.push(source.id);
    }
  };

  for (let i = 0; i < sourceCandidates.length; i += POST_CONCURRENCY) {
    const chunk = sourceCandidates.slice(i, i + POST_CONCURRENCY);
    await Promise.all(chunk.map(processOne));
  }

  return NextResponse.json({
    added,
    failed,
    // Let the UI warn the recruiter when candidates imported without scores.
    unscoredIds: unscoredIds.length > 0 ? unscoredIds : undefined,
    skippedOverseas: skippedOverseas.length > 0 ? skippedOverseas : undefined,
    // Skipped because their library row had < PROFILE_MIN_CHARS of profileText
    // (typically: JobAdder-imported with no CV PDF, so extract-cv-text had
    // nothing to read). UI can prompt the recruiter to upload a CV for them.
    skippedEmpty: skippedEmpty > 0 ? skippedEmpty : undefined,
  });
}
