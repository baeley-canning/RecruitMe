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
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";
import { safeParseJson, buildScoreCacheKey, parseIntParam } from "@/lib/utils";
import { getJobScoringWeights } from "@/lib/scoring-config";
import { getAccessibleOrgIds, candidateOrgFilter } from "@/lib/org-access";
import { shouldRejectAsOverseas } from "@/lib/location";
import { checkRateLimit, checkSpendCap } from "@/lib/usage";
import { reportError } from "@/lib/error-reporting";

// Mirrors CAPTURED_PROFILE_MIN_CHARS in candidate-profile.ts — applied at
// both the GET (modal listing) and POST (import) layers so a candidate with
// no extractable CV / paste can't smuggle into a job via the library modal.
const LIBRARY_PROFILE_MIN_CHARS = 500;

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
  const limit = parseIntParam(url.searchParams.get("limit"), { min: 10, max: 200, default: 50 });
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

  // ── Length-gate the library at SQL ─────────────────────────────────────
  // The "Bede problem": JobAdder-imported candidates with no CV PDF land
  // with profileText="" (CV extraction had nothing to read) but still pass
  // `profileText: { not: null }`. They render as normal cards in the modal
  // and import with zero content. Filter them out at SQL so Prisma never
  // returns them, mirroring the POST-side LIBRARY_PROFILE_MIN_CHARS gate.
  //
  // Prisma's query builder can't express `length("profileText") >= N`, so
  // we pre-fetch the eligible candidate IDs via $queryRaw (just IDs — no
  // profileText shipped to Node) and then feed them into the existing
  // findMany for the column shape. The raw query also pushes the q= filter
  // and org-scope into Postgres so we never pull 14k rows into memory.
  const qLike = q ? `%${q.replace(/[%_\\]/g, "\\$&")}%` : null;
  // accessibleOrgIds === null → owner (no org filter). Empty array → no
  // accessible orgs (return zero rows). Otherwise restrict by job.orgId OR
  // candidate.orgId, matching candidateOrgFilter's semantics.
  const orgIdsParam: string[] = accessibleOrgIds ?? [];
  const useOrgFilter = accessibleOrgIds !== null;
  if (useOrgFilter && orgIdsParam.length === 0) {
    return NextResponse.json({ candidates: [], total: 0 });
  }

  const eligibleRows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT c.id
    FROM "Candidate" c
    LEFT JOIN "Job" j ON j.id = c."jobId"
    WHERE c."profileText" IS NOT NULL
      AND char_length(c."profileText") >= ${LIBRARY_PROFILE_MIN_CHARS}
      AND (
        ${!useOrgFilter}::boolean
        OR j."orgId" = ANY(${orgIdsParam}::text[])
        OR (c."jobId" IS NULL AND c."orgId" = ANY(${orgIdsParam}::text[]))
      )
      AND (
        ${qLike === null}::boolean
        OR c."name"     ILIKE ${qLike ?? ""}
        OR c."headline" ILIKE ${qLike ?? ""}
        OR c."location" ILIKE ${qLike ?? ""}
      )
    ORDER BY c."createdAt" DESC, c."id" DESC
    LIMIT ${prismaTake}
  `;
  const eligibleIds = eligibleRows.map((r) => r.id);
  if (eligibleIds.length === 0) {
    return NextResponse.json({ candidates: [], total: 0 });
  }

  const candidatesRaw = await prisma.candidate.findMany({
    where: { id: { in: eligibleIds } },
    // id-desc tiebreaker against bulk-insert timestamp collisions.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      name: true,
      headline: true,
      location: true,
      linkedinUrl: true,
      photoFileId: true,
      matchScore: true,
      createdAt: true,
      job: { select: { title: true } },
      archivedJobTitle: true,
    },
  });
  // Preserve the raw query's ordering — Prisma's `in:` doesn't guarantee
  // returned-row order matches the input array.
  const byId = new Map(candidatesRaw.map((c) => [c.id, c]));
  const candidates = eligibleIds
    .map((id) => byId.get(id))
    .filter((c): c is NonNullable<typeof c> => c !== undefined);

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

/** Per-candidate Claude cost estimate (USD) used by the dryRun preview.
 *  Conservative figure derived from observed Haiku 4.5 spend on scoring
 *  + acceptance prediction per candidate; bumped slightly to overestimate
 *  rather than under-warn. Override via env for tuning post-deploy. */
const LIBRARY_ESTIMATED_USD_PER_CANDIDATE = Number(
  process.env.LIBRARY_DRYRUN_USD_PER_CANDIDATE ?? 0.02,
);

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;

  const { job, error } = await requireJobAccess(id, auth);
  if (error || !job) return error;

  const reqUrl = new URL(req.url);
  // Pre-pull cost preview: ?dryRun=1 short-circuits before any AI calls
  // and returns { estimatedFinalists, estimatedCostUsd, dailyBudget* } so
  // the UI (PR 4) can warn the recruiter before they spend on a pull that
  // would blow the daily cap. Plan §A decision #4 — pre-pull preview
  // instead of mid-pull abort. dryRun=1 still validates inputs (rate
  // limit, body shape, profile-text length gate) but never writes.
  const isDryRun = reqUrl.searchParams.get("dryRun") === "1";

  // Library import does scoring per row, up to the 50-candidate Zod cap
  // below. Same per-org rate limit + daily USD cap as score-all so a
  // single click can't blow past the $5/day budget.
  // Mirrors the guard pattern in score-all/route.ts:34-48.
  //
  // dryRun skips rate-limit + spend-cap enforcement on purpose — the
  // preview's whole point is "tell me if this pull would fit", not "block
  // me before I can ask". The response surfaces the cap state so the UI
  // can warn before submitting the real POST.
  let rateAllowed = true;
  let rateRetryAfterMs: number | undefined;
  let spent = 0;
  let cap = 0;
  let spendAllowed = true;
  {
    const rateCheck = await checkRateLimit(auth.orgId, "score");
    rateAllowed = rateCheck.allowed;
    rateRetryAfterMs = rateCheck.retryAfterMs;
    const spend = await checkSpendCap(auth.orgId);
    spent = spend.spentUsd;
    cap = spend.capUsd;
    spendAllowed = spend.allowed;
  }
  if (!isDryRun) {
    if (!rateAllowed) {
      const waitMin = Math.ceil((rateRetryAfterMs ?? 60000) / 60000);
      return NextResponse.json({ error: `Scoring rate limit reached. Try again in ~${waitMin} minute${waitMin !== 1 ? "s" : ""}.` }, { status: 429 });
    }
    if (!spendAllowed) {
      return NextResponse.json({
        error: `Daily AI spend cap reached ($${spent.toFixed(2)} / $${cap.toFixed(2)}). Try again tomorrow or raise AI_DAILY_SPEND_CAP_USD.`,
      }, { status: 429 });
    }
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
  // Drop the SQL `profileText: { not: null }` predicate so null-profileText
  // rows still reach the JS gate — otherwise they'd be silently filtered at
  // SQL and `skippedEmpty` would undercount them, leaving the UI showing
  // `added: 0` with no diagnostic. We count nulls + sub-500-chars together
  // as one "empty / too short" bucket.
  const sourceCandidatesRaw = await prisma.candidate.findMany({
    where: {
      id: { in: parsed.data.candidateIds },
      ...candidateOrgFilter(accessibleOrgIds),
    },
  });
  const sourceCandidates = sourceCandidatesRaw.filter(
    (c) => (c.profileText?.trim().length ?? 0) >= LIBRARY_PROFILE_MIN_CHARS,
  );
  // Count BOTH (a) IDs the caller passed that we couldn't find at all
  // (deleted, wrong org, etc.) and (b) IDs we found but whose profileText
  // was null / under the min-chars threshold. Without this the UI shows
  // `added: 0` with no idea why nothing landed.
  const skippedMissingOrEmpty =
    parsed.data.candidateIds.length - sourceCandidates.length;
  if (skippedMissingOrEmpty > 0) {
    console.log(`[library-import] skipped ${skippedMissingOrEmpty} library row(s) — missing, wrong-org, or profileText < ${LIBRARY_PROFILE_MIN_CHARS} chars`);
  }

  // dryRun preview short-circuit. No AI tokens spent, no DB writes.
  // Returns enough information for the UI to warn the recruiter about
  // skipped-empty IDs + projected cost vs daily remaining budget. The
  // estimate is intentionally conservative (LIBRARY_ESTIMATED_USD_PER_CANDIDATE
  // is rounded up) so the UI errs on warning-too-loud, not the reverse.
  if (isDryRun) {
    const estimatedFinalists = sourceCandidates.length;
    const estimatedCostUsd =
      Math.round(estimatedFinalists * LIBRARY_ESTIMATED_USD_PER_CANDIDATE * 1000) / 1000;
    const dailyBudgetRemainingUsd = Math.max(0, cap - spent);
    const wouldExceedCap = estimatedCostUsd > dailyBudgetRemainingUsd;
    return NextResponse.json({
      dryRun: true,
      requestedIds: parsed.data.candidateIds.length,
      eligibleFinalists: estimatedFinalists,
      skippedEmpty: skippedMissingOrEmpty,
      estimatedCostUsd,
      dailyBudgetSpentUsd: Math.round(spent * 100) / 100,
      dailyBudgetCapUsd: cap,
      dailyBudgetRemainingUsd: Math.round(dailyBudgetRemainingUsd * 100) / 100,
      wouldExceedCap,
      rateLimitAllowed: rateAllowed,
      rateRetryAfterMs: rateAllowed ? undefined : rateRetryAfterMs,
    });
  }

  let added = 0;
  const failed: string[] = [];
  const unscoredIds: string[] = []; // imported but scoring failed after retry
  const skippedOverseas: string[] = [];
  // Track every Candidate row this POST created/updated, for the
  // SearchSession importedIds + "Analysis History" panel below. Without
  // this, library imports silently never wrote SearchSession rows — leaving
  // the history panel frozen on the last LinkedIn search. Mirrors the
  // talent-pool route's pattern at route.ts:422.
  const upsertedIds: string[] = [];

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
      upsertedIds.push(upserted.id);
      if (!breakdown) unscoredIds.push(source.id);
    } catch {
      failed.push(source.id);
    }
  };

  for (let i = 0; i < sourceCandidates.length; i += POST_CONCURRENCY) {
    const chunk = sourceCandidates.slice(i, i + POST_CONCURRENCY);
    await Promise.all(chunk.map(processOne));
  }

  // Bug fix (was a silent regression): every pull-into-job event MUST write
  // a SearchSession row so the "Analysis History" panel reflects activity.
  // Pre-fix, library imports never logged here, leaving history frozen on
  // the last LinkedIn search. Same shape as the talent-pool route's pattern
  // at talent-pool/route.ts:422. status: "complete" — library imports are
  // synchronous, no running state. evaluation: "library_modal_import" — a
  // separate marker from talent-pool's "library_only" so we can distinguish
  // manual-pick from keyword-auto-match in the panel later.
  void prisma.searchSession.create({
    data: {
      jobId: id,
      status: "complete",
      // Manual-pick has no query string — record an empty array so the
      // history-render code (which JSON.parses) sees a valid shape.
      queries: JSON.stringify([]),
      location: job.location ?? parsedRole.location_rules ?? "",
      target: parsed.data.candidateIds.length,
      collected: added,
      importedIds: JSON.stringify(upsertedIds),
      message: `Library modal: ${added} imported, ${failed.length} failed, ${skippedMissingOrEmpty} skipped (empty/missing), ${skippedOverseas.length} overseas.`,
      orgId: auth.orgId ?? null,
      totalExamined: parsed.data.candidateIds.length,
      candidatesRejected: skippedMissingOrEmpty + skippedOverseas.length + failed.length,
      evaluation: "library_modal_import",
    },
  }).catch((err) => reportError(err, { route: "library:session-log", jobId: id, orgId: auth.orgId }));

  return NextResponse.json({
    added,
    failed,
    // Let the UI warn the recruiter when candidates imported without scores.
    unscoredIds: unscoredIds.length > 0 ? unscoredIds : undefined,
    skippedOverseas: skippedOverseas.length > 0 ? skippedOverseas : undefined,
    // Skipped because their library row had < PROFILE_MIN_CHARS of
    // profileText OR was missing entirely (deleted/wrong-org). Typically:
    // JobAdder-imported with no CV PDF, so extract-cv-text had nothing to
    // read. UI can prompt the recruiter to upload a CV for these.
    skippedEmpty: skippedMissingOrEmpty > 0 ? skippedMissingOrEmpty : undefined,
  });
}
