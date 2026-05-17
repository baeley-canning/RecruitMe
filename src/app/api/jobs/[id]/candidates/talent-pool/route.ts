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
import { tryAcquireLock, releaseLock } from "@/lib/db-lock";
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
  const { maxResults } = parsed.data;

  const { job, error } = await requireJobAccess(jobId, auth);
  if (error || !job) return error;

  // Per-job advisory lock — two recruiters clicking "Library" on the same
  // job at the same time would otherwise both walk the same pool and race
  // on upserts. Cheap to hold for a sub-second hard-match pass. Stale
  // entries auto-clear after 15 min per the db-lock default.
  const lockName = `talent-pool:${jobId}`;
  const lockAcquired = await tryAcquireLock(lockName);
  if (!lockAcquired) {
    return NextResponse.json({
      error: "A library search is already running for this job. Wait a minute and try again.",
    }, { status: 429 });
  }
  try {

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
  const prefilterTerms = earlyMustHaves
    .flatMap((req) => extractSignalsFromRequirement(req))
    .filter((s) => s.length >= 3 && !/^\d+$/.test(s))
    .slice(0, 12); // cap to keep the WHERE clause sane
  const usePrefilter = prefilterTerms.length >= 3;
  const prefilterClause = usePrefilter
    ? { OR: prefilterTerms.map((t) => ({ profileText: { contains: t, mode: "insensitive" as const } })) }
    : {};

  const poolRows = await prisma.candidate.findMany({
    where: {
      jobId: { not: jobId },
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
    },
    // id-desc tiebreaker prevents bulk-import timestamp-ties from biasing
    // the head when many rows share one createdAt. Cap of 12k stays as a
    // safety net for the no-prefilter fallback path.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 12000,
  });
  console.log(`[talent-pool] pre-filter terms=${prefilterTerms.length} usePrefilter=${usePrefilter} → ${poolRows.length} rows`);

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
      const hasSignal = roleTerms.some((term) => haystack.includes(term));
      if (!hasSignal) { skippedRequirements++; continue; }
    } else {
      const hasMustHaveSignal = mustHaveSignalSets.some(
        (signals) => signals.some((s) => signalMatchesText(haystack, s)),
      );
      if (!hasMustHaveSignal && !candidateTitleFitsRole(parsedRole.title, row.headline)) {
        skippedRequirements++;
        continue;
      }
    }

    try {
      const identityKey = poolImportKey(row);
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
          jobAdderUrl: row.jobAdderUrl ?? null,
          profileText: row.profileText,
          source: "talent_pool",
          status: "new",
          ...(row.profileCapturedAt ? { profileCapturedAt: row.profileCapturedAt } : {}),
        },
        update: {
          source: "talent_pool",
          ...(row.jobAdderUrl ? { jobAdderUrl: row.jobAdderUrl } : {}),
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

  if (saved.length === 0) {
    const reason = skippedRequirements > 0
      ? `${skippedRequirements} library profile${skippedRequirements !== 1 ? "s" : ""} didn't mention this role's must-haves.${partialNote}`
      : skippedOverseas > 0
        ? `Skipped ${skippedOverseas} overseas candidate${skippedOverseas !== 1 ? "s" : ""}; no NZ-based pool candidates matched.${partialNote}`
        : `No pool candidates matched this role's requirements.${partialNote}`;
    return NextResponse.json({ count: 0, candidates: [], message: reason, skippedOverseas, stoppedEarly });
  }

  return NextResponse.json({
    count: saved.length,
    candidates: saved,
    skippedOverseas,
    stoppedEarly,
    message: `Imported ${saved.length} from the library — click Score all to rank against this JD.${partialNote}`,
  });
  } finally {
    await releaseLock(lockName);
  }
}
