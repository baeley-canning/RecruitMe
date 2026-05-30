/**
 * POST /api/jobs/[id]/candidates/talent-pool
 *
 * Searches the local talent pool (all Candidate rows with a full profile /
 * CV text, across every job) and adds any matching, not-yet-imported
 * candidates to this job. Hard-match only — no AI scoring at import time.
 *
 * Pipeline is entirely deterministic:
 *   1. SQL prefilter (pg_trgm GIN on profileText) → candidates mentioning a must-have
 *   2. Dedup by LinkedIn URL / internal library key
 *   3. Overseas reject (location / headline / profile text gate)
 *   4. Specialist-anchor gate (≥2 distinctive role terms) OR must-have signal coverage
 *   5. Save with matchScore = null and source = "talent_pool"
 *
 * Recruiter clicks "Score all" afterwards to spend AI tokens on the survivors —
 * keeps library imports free and decouples spend from discovery.
 */

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { enrichCandidateInBackground } from "@/lib/firmable-enrich";
import { candidateTitleFitsRole } from "@/lib/title-family";
import type { ParsedRole } from "@/lib/ai";
import { safeParseJson } from "@/lib/utils";
import { normaliseLinkedInUrl } from "@/lib/linkedin";
import { shouldRejectAsOverseas } from "@/lib/location";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";
import { getAccessibleOrgIds } from "@/lib/org-access";
import { CAPTURED_PROFILE_MIN_CHARS, hasFullCandidateProfile } from "@/lib/candidate-profile";
import { reportError } from "@/lib/error-reporting";
import { extractSignalsFromRequirement, signalMatchesText } from "@/lib/requirement-signals";
import { extractRoleAwareDistinctiveAnchors } from "@/lib/requirement-signals";

// Frontend aborts at 50s and a 45s internal TIME_BUDGET_MS gates the batch
// score, but the route itself can run a hair longer (Firmable enrichment
// kicks off after the batch, saves run sequentially). 60s gives the platform
// proxy headroom over Vercel/Railway's default 10-15s function timeout
// without uncapping it.
export const maxDuration = 60;

// Re-derive distinctive terms from a parsedRole — role-aware so hybrid IT-ops
// roles ("Technology Support Manager") don't gate the pool on ISMS/ISO 27001
// when the role's secondary compliance requirement would otherwise reject
// good IT-ops candidates whose full profile doesn't surface the acronym.
function distinctiveTerms(parsedRole: ParsedRole): string[] {
  return extractRoleAwareDistinctiveAnchors({
    title: parsedRole.title,
    requirements: [
      ...(parsedRole.must_haves ?? []),
      ...(parsedRole.knockout_criteria ?? []),
    ],
  }).map((t) => t.toLowerCase());
}

const BodySchema = z.object({
  maxResults: z.number().int().min(1).max(200).default(50),
}).passthrough(); // accept legacy radiusKm/centerLat/Lng without rejecting older clients

function poolImportKey(row: { id: string; linkedinUrl?: string | null }): string {
  const raw = row.linkedinUrl?.trim();
  if (!raw) return `library:${row.id}`;
  return /^https?:\/\//i.test(raw) ? normaliseLinkedInUrl(raw) : raw;
}

function hasReusablePoolProfile(row: {
  source: string | null;
  profileCapturedAt: Date | string | null;
  profileText: string | null;
}): boolean {
  const charCount = row.profileText?.trim().length ?? 0;
  if (row.source === "jobadder_import" && charCount >= CAPTURED_PROFILE_MIN_CHARS) return true;
  return hasFullCandidateProfile(row);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id: jobId } = await params;

  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  // One batch id per "auto-import N from pool" call so the resulting rows
  // can be filtered as a single group in the library (Phase E).
  const importBatchId = randomUUID();
  const { maxResults } = parsed.data;

  const { job, error } = await requireJobAccess(jobId, auth);
  if (error || !job) return error;

  // Removed the per-job advisory lock that used to wrap this route. It made
  // sense when each click fired ~$1-3 in Claude scoring, but since the
  // route is hard-match-only the only race protection we need is the
  // (jobId, linkedinUrl) unique constraint — which the upsert below
  // already handles. The lock was actively biting recruiters: a crashed
  // run or client-aborted fetch would leave the Setting row stuck for 15
  // minutes, returning 429 on every subsequent click until TTL.

  const parsedRole = safeParseJson<ParsedRole | null>(job.parsedRole, null);
  if (!parsedRole) {
    return NextResponse.json(
      { error: "Analyse the job description first before searching the talent pool." },
      { status: 400 }
    );
  }


  // 1. Collect existing pool identity keys already in this job so we skip
  // duplicates. LinkedIn-backed rows use the normalised LinkedIn URL; ATS /
  // JobAdder-only library rows use an internal `library:<sourceCandidateId>`
  // key stored in linkedinUrl purely to satisfy the (jobId, linkedinUrl)
  // uniqueness constraint. displayableLinkedinUrl hides non-http keys in UI.
  const existingUrls = new Set(
    (await prisma.candidate.findMany({
      where: { jobId },
      select: { linkedinUrl: true },
    }))
      .map((c) => {
        const raw = c.linkedinUrl?.trim();
        if (!raw) return null;
        return /^https?:\/\//i.test(raw) ? normaliseLinkedInUrl(raw) : raw;
      })
      .filter(Boolean)
  );

  // 2. Pull all candidates with a full profile from any org the caller can
  // read (own org + cross-org library_read grants). Owners see all.
  const accessibleOrgIds = await getAccessibleOrgIds(auth);

  // SQL-side pre-filter: when the JD has enough must-have signals, push
  // a substring-OR clause into Postgres. The pg_trgm GIN index on
  // profileText (apply-schema-changes step 11) makes ILIKE %term% an
  // index-backed scan rather than a sequential table scan. This cuts
  // 14k rows down to typically ~500-2000 (candidates who mention any
  // must-have term) before we hydrate profileText into Node memory.
  //
  // When the JD has <3 must-have signals (parse failure, generic role)
  // we fall back to the old "pull everything, rank in JS" path so a
  // thin JD doesn't surface nothing.
  const earlyMustHaves = parsedRole.must_haves?.length ? parsedRole.must_haves : (parsedRole.skills_required ?? []);
  const mustHaveSignalTerms = earlyMustHaves
    .flatMap((req) => extractSignalsFromRequirement(req))
    .filter((s) => s.length >= 3 && !/^\d+$/.test(s));
  // Critic A extra #1: when the must-have signal list is thin (3-5 terms),
  // the OR-prefilter combined with the 12k take cap can mathematically miss
  // candidates who match only ONE of the must-haves but otherwise have a
  // strong nice-to-have spine. Widen the OR-set with nice-to-have signals
  // so the prefilter behaves like a relevance gate, not a hard exclusion,
  // when the JD's must-haves are sparse. ≥6 must-have terms already gives
  // the index plenty to work with so we leave those JDs alone.
  const PREFILTER_TERMS_THIN_THRESHOLD = 6;
  const PREFILTER_TERMS_HARD_CAP = 12;
  const PREFILTER_TERMS_MIN = 3;
  const widenWithNiceToHaves = mustHaveSignalTerms.length >= PREFILTER_TERMS_MIN
    && mustHaveSignalTerms.length < PREFILTER_TERMS_THIN_THRESHOLD;
  const niceToHavesForPrefilter = widenWithNiceToHaves
    ? (parsedRole.nice_to_haves?.length ? parsedRole.nice_to_haves : (parsedRole.skills_preferred ?? []))
    : [];
  const niceToHaveSignalTerms = niceToHavesForPrefilter
    .flatMap((req) => extractSignalsFromRequirement(req))
    .filter((s) => s.length >= 3 && !/^\d+$/.test(s));
  // Dedup against the must-have terms (case-insensitive) so we don't burn
  // OR slots on duplicates that the index would already match.
  const seenLower = new Set(mustHaveSignalTerms.map((t) => t.toLowerCase()));
  const widenedNiceToHaves: string[] = [];
  for (const t of niceToHaveSignalTerms) {
    const k = t.toLowerCase();
    if (seenLower.has(k)) continue;
    seenLower.add(k);
    widenedNiceToHaves.push(t);
  }
  const prefilterTerms = [...mustHaveSignalTerms, ...widenedNiceToHaves]
    .slice(0, PREFILTER_TERMS_HARD_CAP);
  const usePrefilter = mustHaveSignalTerms.length >= PREFILTER_TERMS_MIN;
  const prefilterClause = usePrefilter
    ? { OR: prefilterTerms.map((t) => ({ profileText: { contains: t, mode: "insensitive" as const } })) }
    : {};

  const poolRows = await prisma.candidate.findMany({
    where: {
      // "Not in this job" means jobId IS NULL (orphaned JobAdder/library
      // candidate) OR jobId points at a different job. Plain
      // `jobId: { not: jobId }` translates to SQL `jobId != X` which
      // EXCLUDES NULLs by three-valued logic — silently hiding every
      // JobAdder-imported candidate whose original job was deleted (so
      // jobId is null and they live only in the library). This was the
      // root cause of the user-reported "library search never finds
      // JobAdder candidates" bug. Explicit OR to include NULLs.
      OR: [
        { jobId: null },
        { jobId: { not: jobId } },
      ],
      profileText: { not: null },
      ...prefilterClause,
      ...(accessibleOrgIds === null
        ? {}
        : {
            AND: {
              OR: [
                { job: { orgId: { in: accessibleOrgIds } } },
                { jobId: null, orgId: { in: accessibleOrgIds } },
              ],
            },
          }),
    },
    select: {
      id: true,
      name: true,
      headline: true,
      location: true,
      linkedinUrl: true,
      jobAdderUrl: true,
      source: true,
      profileText: true,
      profileCapturedAt: true,
      createdAt: true,
      orgId: true,
      job: { select: { orgId: true } },
    },
    // CRITICAL perf note: only apply SQL `orderBy` on the no-prefilter
    // path. With prefilter ON, Postgres's planner picks the trgm GIN
    // bitmap scan — but adding `ORDER BY createdAt DESC LIMIT 12000`
    // makes the planner prefer a sequential createdAt index scan that
    // filters in-place, defeating the GIN bitmap entirely and forcing
    // a 14k-row sort over TOAST'd profileText. That blew through the
    // 50s frontend abort on prod. With the orderBy gone, GIN bitmap +
    // heap fetch is fast; the JS relevance ranker below resorts anyway.
    //
    // take cap: 2000 with prefilter is plenty (typical match count is
    // ~500-2000 anyway). 12000 stays only as the no-prefilter safety
    // net so a thin JD doesn't silently miss the whole library.
    ...(usePrefilter ? {} : { orderBy: [{ createdAt: "desc" }, { id: "desc" }] }),
    take: usePrefilter ? 2000 : 12000,
  });
  console.log(`[talent-pool] pre-filter terms=${prefilterTerms.length} (must=${mustHaveSignalTerms.length}, widened-with-nice-to-haves=${widenedNiceToHaves.length}) usePrefilter=${usePrefilter} → ${poolRows.length} rows`);

  // 3. Deduplicate by reusable pool identity, keep the freshest profile per
  // identity. JobAdder/CV imports may not have LinkedIn URLs, so they get a
  // stable internal key instead of being silently thrown away.
  const bestByIdentity = new Map<string, typeof poolRows[number]>();
  for (const row of poolRows) {
    if (!hasReusablePoolProfile(row)) continue;
    let identityKey: string;
    try { identityKey = poolImportKey(row); } catch { continue; }
    if (existingUrls.has(identityKey)) continue;

    const existing = bestByIdentity.get(identityKey);
    if (!existing) { bestByIdentity.set(identityKey, row); continue; }
    const rowDate = row.profileCapturedAt ?? row.createdAt;
    const existDate = existing.profileCapturedAt ?? existing.createdAt;
    if (rowDate > existDate) bestByIdentity.set(identityKey, row);
  }

  const candidatesBeforeRank = [...bestByIdentity.values()];
  console.log(`[talent-pool] ${candidatesBeforeRank.length} unique profiles in pool (excluding this job)`);

  if (candidatesBeforeRank.length === 0) {
    return NextResponse.json({
      count: 0, candidates: [],
      message: "No reusable library profiles available yet. Capture LinkedIn profiles or import CV/JobAdder candidates first.",
    });
  }

  // Pre-rank by relevance to the JD's must-haves + nice-to-haves. This is
  // a cheap keyword-density pass that costs zero AI tokens — we just want
  // the 100 most-relevant candidates at the top of the queue so Claude
  // batch scoring spends its budget on the right people.
  //
  // Previously: candidates were ordered by createdAt desc, which after a
  // bulk import meant the first 100 the route saw were name-sorted ties
  // from the import (~3 of 25 actually matched the role).
  const mustHavesForRank   = parsedRole.must_haves?.length ? parsedRole.must_haves : (parsedRole.skills_required ?? []);
  const niceToHavesForRank = parsedRole.nice_to_haves?.length ? parsedRole.nice_to_haves : (parsedRole.skills_preferred ?? []);
  const computeRelevance = (row: typeof candidatesBeforeRank[number]): number => {
    const haystack = (row.profileText ?? "").toLowerCase();
    if (!haystack) return -Infinity;
    let score = 0;
    for (const req of mustHavesForRank) {
      const signals = extractSignalsFromRequirement(req);
      if (signals.some((s) => signalMatchesText(haystack, s))) score += 3;
    }
    for (const req of niceToHavesForRank.slice(0, 8)) {
      const signals = extractSignalsFromRequirement(req);
      if (signals.some((s) => signalMatchesText(haystack, s))) score += 1;
    }
    // Tie-break: prefer recently-captured (more current profile content).
    // Coerce — tests pass createdAt as strings; runtime Prisma passes Dates.
    const raw = row.profileCapturedAt ?? row.createdAt;
    const t = raw instanceof Date ? raw.getTime() : new Date(raw as unknown as string).getTime();
    score += (Number.isFinite(t) ? t : 0) / 1e15; // tiny additive — only breaks ties
    return score;
  };
  const candidates = candidatesBeforeRank
    .map((row) => ({ row, relevance: computeRelevance(row) }))
    .sort((a, b) => b.relevance - a.relevance)
    .map(({ row }) => row);
  console.log(`[talent-pool] ranked by JD relevance — top candidate score=${computeRelevance(candidates[0])}, bottom=${computeRelevance(candidates[candidates.length - 1])}`);

  // 4. Hard-match admission gate + save. No AI scoring runs here — the
  //    recruiter clicks "Score all" afterwards to spend tokens on the
  //    candidates they've actually imported.
  type SavedCandidate = NonNullable<Awaited<ReturnType<typeof prisma.candidate.findFirst>>>;
  const saved: SavedCandidate[] = [];
  let skippedRequirements = 0;
  let skippedOverseas = 0;
  let stoppedEarly = false;

  // For specialist roles (SAFe Scrum Master, C++/Sybase developer, etc.) the pool
  // should only import candidates who have at least one distinctive term in their
  // full profile. Without this gate, every Wellington developer in the pool gets
  // added to every specialist job — e.g. an Azure architect ends up on a Scrum
  // Master candidate list because they're both Wellington-based.
  //
  // ≥2 anchors flips on strict mode; otherwise we admit on must-have signal
  // coverage + title-family fallback so a .NET role whose only rare anchor is
  // "SQL Server" doesn't drop every Postgres dev.
  const roleTerms = distinctiveTerms(parsedRole);
  const isSpecialistRole = roleTerms.length >= 2;
  const mustHaveSignalSets = mustHavesForRank.map((req) => extractSignalsFromRequirement(req));

  for (const row of candidates) {
    if (saved.length >= maxResults) {
      stoppedEarly = candidates.length > saved.length;
      break;
    }
    if (!row.profileText) continue;

    const overseasCheck = shouldRejectAsOverseas({
      explicitLocation: row.location ?? "",
      headline: row.headline,
      profileText: row.profileText,
      isRemote: job.isRemote,
    });
    if (overseasCheck.reject) {
      skippedOverseas++;
      continue;
    }

    const haystack = row.profileText.toLowerCase();
    if (isSpecialistRole) {
      // Bug fix: previously `haystack.includes(term)` — that matches "sql"
      // inside "nosql" / "mssql" and "php" inside "phpipam-admin", silently
      // admitting adjacent-stack candidates to specialist roles (Critic B
      // §1, talent-pool/route.ts:346). signalMatchesText is already used at
      // line 350 for non-specialist roles; bringing the specialist branch
      // in line gives both gates the same word-boundary protection.
      const hasSignal = roleTerms.some((term) => signalMatchesText(haystack, term));
      if (!hasSignal) { skippedRequirements++; continue; }
    } else {
      const hasMustHaveSignal = mustHaveSignalSets.some(
        (signals) => signals.some((s) => signalMatchesText(haystack, s)),
      );
      // When ANY must-have produces extractable signals, demand a signal hit —
      // title-fit alone isn't enough. Reason: candidateTitleFitsRole returns
      // true whenever EITHER side is unclassified (title-family.ts:294), so
      // soft-skill JDs like "Quoting Specialist" (no family pattern matches)
      // used to admit every candidate via the title-fit fallback regardless
      // of what their CV said. We only fall back to title-fit when the JD is
      // genuinely signal-less (parse failure or pure soft-skill prose with
      // no role-distinctive nouns at all).
      const hasAnyExtractableSignals = mustHaveSignalSets.some((s) => s.length > 0);
      const admitted = hasAnyExtractableSignals
        ? hasMustHaveSignal
        : candidateTitleFitsRole(parsedRole.title, row.headline);
      if (!admitted) {
        skippedRequirements++;
        continue;
      }
    }

    try {
      const identityKey = poolImportKey(row);
      // Privacy: strip jobAdderUrl when importing from another org's library.
      // The ATS URL points at the provider org's JobAdder record; copying it
      // into the viewer org's candidate row would let the viewer hit the
      // provider's ATS (assuming they have JobAdder credentials). Same-org
      // imports keep the URL.
      const sourceOrgId = row.job?.orgId ?? row.orgId ?? null;
      const isCrossOrgImport = sourceOrgId !== null && sourceOrgId !== (job.orgId ?? null);
      const portableJobAdderUrl = isCrossOrgImport ? null : (row.jobAdderUrl ?? null);

      // Upsert because the search route and this route can both fire for
      // the same job simultaneously; create would P2002 on (jobId, linkedinUrl).
      // We DON'T touch matchScore / breakdown fields here — preserving any
      // prior score if this candidate was already imported and scored.
      const candidate = await prisma.candidate.upsert({
        where: { jobId_linkedinUrl: { jobId, linkedinUrl: identityKey } },
        create: {
          jobId,
          orgId: job.orgId ?? null,
          name: row.name,
          headline: row.headline,
          location: row.location || null,
          linkedinUrl: identityKey,
          jobAdderUrl: portableJobAdderUrl,
          profileText: row.profileText,
          source: "talent_pool",
          status: "new",
          importBatchId,
          ...(row.profileCapturedAt ? { profileCapturedAt: row.profileCapturedAt } : {}),
        },
        update: {
          source: "talent_pool",
          ...(portableJobAdderUrl ? { jobAdderUrl: portableJobAdderUrl } : {}),
          ...(row.profileCapturedAt ? { profileCapturedAt: row.profileCapturedAt } : {}),
        },
      });
      saved.push(candidate as SavedCandidate);
    } catch (err) {
      reportError(err, { route: "talent-pool:save", jobId, orgId: auth.orgId, candidateId: row.id });
    }
  }

  console.log(`[talent-pool] done — imported ${saved.length}, skipped ${skippedRequirements} on requirements, ${skippedOverseas} overseas, stoppedEarly=${stoppedEarly}`);

  // Background phone enrichment for the just-saved candidates. Cached for 90d
  // per identity so re-imports across jobs don't re-burn credits.
  for (const c of saved) enrichCandidateInBackground(c.id);

  const partialNote = stoppedEarly
    ? ` (Library is large — imported the first ${saved.length}; click search again to pull more.)`
    : "";

  const baseMessage = saved.length > 0
    ? `Imported ${saved.length} from the library — click Score all to rank against this JD.${partialNote}`
    : skippedRequirements > 0
      ? `${skippedRequirements} library profile${skippedRequirements !== 1 ? "s" : ""} didn't mention this role's must-haves.${partialNote}`
      : skippedOverseas > 0
        ? `Skipped ${skippedOverseas} overseas candidate${skippedOverseas !== 1 ? "s" : ""}; no NZ-based pool candidates matched.${partialNote}`
        : `No pool candidates matched this role's requirements.${partialNote}`;

  // Log a SearchSession row so the "Analysis History" panel reflects library
  // searches with today's date. Pre-fix, only LinkedIn searches wrote here,
  // so library-only users saw their history frozen on the last LinkedIn run.
  // status: "complete" — library imports are synchronous, no running state.
  void prisma.searchSession.create({
    data: {
      jobId,
      status: "complete",
      queries: JSON.stringify(prefilterTerms),
      location: job.location ?? parsedRole.location_rules ?? "",
      target: maxResults,
      collected: saved.length,
      importedIds: JSON.stringify(saved.map((c) => c.id)),
      message: baseMessage,
      orgId: auth.orgId ?? null,
      totalExamined: candidates.length,
      candidatesRejected: skippedRequirements + skippedOverseas,
      evaluation: "library_only",
    },
  }).catch((err) => reportError(err, { route: "talent-pool:session-log", jobId, orgId: auth.orgId }));

  if (saved.length === 0) {
    return NextResponse.json({ count: 0, candidates: [], message: baseMessage, skippedOverseas, stoppedEarly });
  }

  return NextResponse.json({
    count: saved.length,
    candidates: saved,
    skippedOverseas,
    stoppedEarly,
    message: baseMessage,
  });
}
