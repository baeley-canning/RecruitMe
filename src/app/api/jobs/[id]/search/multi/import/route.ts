/**
 * POST /api/jobs/[id]/search/multi/import — bulk-add selected
 * UnifiedResult rows to a job. Sibling to the Day 3 multi-search route;
 * the UI's "Add N selected to job" button calls here.
 *
 * Behaviour:
 *  • For each result, upsert a Candidate row tied to THIS jobId.
 *  • Library-sourced rows: copy headline/location/profileText/linkedinUrl
 *    from the existing source Candidate row (verified accessible via
 *    org-scope first). Same pattern as talent-pool route's save loop.
 *  • LinkedIn-only rows: insert as snippet-stage candidate
 *    (linkedinUrl + headline from SerpAPI + snippet as profileText)
 *    so the recruiter can fetch the full profile and score later.
 *  • Both-sources rows: prefer library data (more reliable).
 *  • Upsert keyed on (jobId, linkedinUrl) so re-imports are idempotent.
 *  • NO AI scoring fires at attach time — recruiter clicks Score-all
 *    afterwards (same UX pattern as existing browse-library + talent-pool).
 *
 * Cost-discipline: zero AI tokens at import. Recruiter spends those
 * deliberately via score-all on the rows they keep.
 *
 * Auth: getAuth + requireJobAccess. Cross-org library rows checked via
 * getAccessibleOrgIds + per-row orgId verification (defence-in-depth
 * over the original multi-search result list which trusted the
 * recruiter's selections).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";
import { getAccessibleOrgIds } from "@/lib/org-access";
import { normaliseLinkedInUrl, isLinkedInProfileUrl } from "@/lib/linkedin";
import { reportError } from "@/lib/error-reporting";

// Mirrors UnifiedResult from src/lib/talent-search/aggregate.ts but only
// the fields the import route actually consumes. Keeping a separate
// Zod-validated shape so a malicious client can't push extra fields
// onto Candidate.create via passthrough.
const ImportRowSchema = z.object({
  id: z.string(),
  name: z.string().max(500),
  headline: z.string().nullable(),
  location: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  jobAdderUrl: z.string().nullable(),
  sources: z.array(z.enum(["library", "linkedin"])).min(1),
  candidateId: z.string().nullable(),
  candidateIdentityId: z.string().nullable(),
  snippet: z.string().nullable(),
});

// Cap high enough to cover a full "Select all" over library + LinkedIn + SEEK
// (the modal can surface ~200+ rows); the old max(100) rejected a 185-row
// select-all with a 422 so nothing got added. Processed with bounded
// concurrency below so a large batch still finishes in seconds.
const BodySchema = z.object({
  results: z.array(ImportRowSchema).min(1).max(500),
});

// How many rows to import at once. Each importOne upserts a distinct
// (jobId, linkedinUrl) row, so concurrent writes don't collide; this keeps a
// 185-row add at a few seconds instead of a 20s+ serial crawl.
const IMPORT_CONCURRENCY = 10;

type ImportRow = z.infer<typeof ImportRowSchema>;

interface ImportOutcome {
  resultId: string;
  candidateId?: string;
  /** "attached" — created or re-attached this candidate to the job */
  /** "skipped" — couldn't be attached (no URL key, cross-org, etc.) */
  /** "failed" — exception during DB write */
  status: "attached" | "skipped" | "failed";
  reason?: string;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id: jobId } = await params;

  const { job, error: accessError } = await requireJobAccess(jobId, auth);
  if (accessError || !job) return accessError;

  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });
  }
  const { results } = parsed.data;

  const accessibleOrgIds = await getAccessibleOrgIds(auth);

  // Dedup within the selection by stable id. Recruiter shouldn't be able
  // to send the same row twice, but defence-in-depth.
  const seenIds = new Set<string>();
  const uniqueResults = results.filter((r) => {
    if (seenIds.has(r.id)) return false;
    seenIds.add(r.id);
    return true;
  });

  // Bounded-concurrency worker pool — IMPORT_CONCURRENCY rows in flight at once.
  // Each importOne keys on a distinct (jobId, linkedinUrl), so parallel upserts
  // don't race; outcomes are written by index to preserve order.
  const outcomes: ImportOutcome[] = new Array(uniqueResults.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= uniqueResults.length) return;
      const row = uniqueResults[i];
      try {
        outcomes[i] = await importOne(row, jobId, job.orgId ?? null, accessibleOrgIds);
      } catch (err) {
        reportError(err, { route: "search/multi/import", jobId, orgId: auth.orgId, resultId: row.id });
        outcomes[i] = {
          resultId: row.id,
          status: "failed",
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(IMPORT_CONCURRENCY, uniqueResults.length) }, worker),
  );

  const counts = {
    attached: outcomes.filter((o) => o.status === "attached").length,
    skipped: outcomes.filter((o) => o.status === "skipped").length,
    failed: outcomes.filter((o) => o.status === "failed").length,
    total: outcomes.length,
  };

  return NextResponse.json({ outcomes, counts });
}

/**
 * Attach a single UnifiedResult to the job. Returns the outcome shape
 * the route aggregates into the response. Never throws — caller catches
 * and converts to a "failed" outcome.
 *
 * Decision tree:
 *  1. Result includes "library" + has candidateId → look up source
 *     candidate, verify it's accessible to this caller, copy its data
 *     onto a new Candidate row tied to THIS jobId.
 *  2. Result is linkedin-only (no candidateId) → must have linkedinUrl
 *     to attach (we key on (jobId, linkedinUrl)). Create snippet-stage
 *     Candidate row.
 *  3. No usable URL key → "skipped" with reason.
 */
async function importOne(
  row: ImportRow,
  jobId: string,
  jobOrgId: string | null,
  accessibleOrgIds: string[] | null,
): Promise<ImportOutcome> {
  const isLibrary = row.sources.includes("library") && row.candidateId;
  // Require a GENUINE linkedin.com/in/<slug> URL before treating a row as
  // LinkedIn-only — otherwise normaliseLinkedInUrl() wraps a non-LinkedIn URL
  // (e.g. a SEEK talentsearch URL) into a broken `linkedin.com/in/https://…`
  // value and persists it. Such rows fall through to "skipped" instead.
  const isLinkedinOnly = !isLibrary && row.sources.includes("linkedin") && !!row.linkedinUrl && isLinkedInProfileUrl(row.linkedinUrl);

  // ── Library path ─────────────────────────────────────────────────────
  if (isLibrary) {
    const source = await prisma.candidate.findUnique({
      where: { id: row.candidateId! },
      select: {
        id: true,
        name: true,
        headline: true,
        location: true,
        linkedinUrl: true,
        jobAdderUrl: true,
        seekUrl: true,
        profileText: true,
        profileCapturedAt: true,
        orgId: true,
        job: { select: { orgId: true } },
      },
    });
    if (!source) {
      return { resultId: row.id, status: "skipped", reason: "library_source_not_found" };
    }
    // Org-scope check: caller must have access to the source's org.
    // accessibleOrgIds === null = owner; otherwise verify.
    const sourceOrgId = source.orgId ?? source.job?.orgId ?? null;
    if (accessibleOrgIds !== null && (!sourceOrgId || !accessibleOrgIds.includes(sourceOrgId))) {
      return { resultId: row.id, status: "skipped", reason: "cross_org_no_access" };
    }
    // Synthesise a stable URL key for the (jobId, linkedinUrl) unique
    // constraint when the source has no real linkedinUrl. Same shape as
    // talent-pool route's poolImportKey.
    const linkedinUrl = source.linkedinUrl ?? `library:${source.id}`;
    const upserted = await prisma.candidate.upsert({
      where: { jobId_linkedinUrl: { jobId, linkedinUrl } },
      create: {
        jobId,
        orgId: jobOrgId,
        name: source.name,
        headline: source.headline,
        location: source.location,
        linkedinUrl,
        // Strip jobAdderUrl on cross-org imports — points at provider's
        // ATS, copying it would let the viewer hit the provider's
        // JobAdder record. Same defence as talent-pool route.
        jobAdderUrl: accessibleOrgIds === null || sourceOrgId === jobOrgId
          ? source.jobAdderUrl
          : null,
        // Preserve SEEK identity on the job Candidate row (Phase 0) so the
        // imported candidate keeps its seekUrl for dedup/linking.
        seekUrl: source.seekUrl,
        profileText: source.profileText,
        source: "talent_pool",
        status: "new",
        ...(source.profileCapturedAt ? { profileCapturedAt: source.profileCapturedAt } : {}),
      },
      update: {
        source: "talent_pool",
      },
    });
    return { resultId: row.id, status: "attached", candidateId: upserted.id };
  }

  // ── LinkedIn-only path ───────────────────────────────────────────────
  if (isLinkedinOnly) {
    const normalised = normaliseLinkedInUrl(row.linkedinUrl!);
    const upserted = await prisma.candidate.upsert({
      where: { jobId_linkedinUrl: { jobId, linkedinUrl: normalised } },
      create: {
        jobId,
        orgId: jobOrgId,
        name: row.name || "Unknown",
        headline: row.headline,
        location: row.location,
        linkedinUrl: normalised,
        // Snippet becomes profileText so the row has SOMETHING to score
        // against until a full-profile fetch (extension or PDL) populates
        // the real profile. Mirrors the search route's snippet-import
        // behaviour.
        profileText: row.snippet,
        source: "scraper",
        status: "new",
      },
      update: {
        // Preserve any existing profileText / scoring — re-import shouldn't
        // wipe data. Only updates the source tag.
        source: "scraper",
      },
    });
    return { resultId: row.id, status: "attached", candidateId: upserted.id };
  }

  return {
    resultId: row.id,
    status: "skipped",
    reason: "no_usable_url_key",
  };
}
