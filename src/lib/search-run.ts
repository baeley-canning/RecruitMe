/**
 * Durable multi-source search lifecycle (Phase K).
 *
 * A SearchRun captures a recruiter's boolean query once and survives
 * navigation: library FTS attaches synchronously at create time; LinkedIn /
 * SEEK discovery runs asynchronously via child ScrapeJobs (kind="search" →
 * harvested URLs → kind="profile" → ingest). Each result attaches as a
 * SearchRunResult row. The run flips to a terminal status when its last
 * child ScrapeJob settles (settleRunIfDone), backstopped by sweepStuckRuns.
 *
 * Concurrency correctness (see the adversarial critique that shaped this):
 *  - settleRunIfDone serializes per-run via SELECT ... FOR UPDATE so two
 *    children finishing near-simultaneously can't deadlock into a no-flip.
 *  - reclaimStaleJobs bounces zombie "processing" jobs (dead worker) so a
 *    run can't hang forever counting a stuck child as in-flight.
 *  - result dedup uses identity-merge keys + an ON CONFLICT upsert, and
 *    late-arriving ingested profiles reconcile against the existing library
 *    row for the same candidate rather than double-counting.
 */

import { randomUUID } from "node:crypto";
import { prisma } from "./db";
import {
  identityMergeKey,
  mergeKeyToString,
} from "./identity-merge";
import { getCandidatePhotoUrl } from "./candidate-photo";
import { looksLikeCapturedName, sanitizeCardField } from "./linkedin-capture";
import { locationMatches } from "./nz-locations";
import { parseBooleanQuery, scoreTextRelevance, type ParsedQuery } from "./boolean-query";
import type { LibrarySearchResult } from "./talent-search/library";

export type SourceKey = "library" | "linkedin" | "seek";
export type SourceStatus = "skipped" | "pending" | "running" | "complete" | "failed";
export type RunStatus = "queued" | "running" | "complete" | "partial" | "failed";

const STALE_PROCESSING_MS = 10 * 60 * 1000; // 10 min
const STUCK_QUEUED_MS = 30 * 1000; // re-drive a queued run abandoned mid-POST
const MAX_RETRIES = 3; // mirror the scraper PATCH handler

// ── merge-key helpers ───────────────────────────────────────────────────────

/** Tier-1 merge key for a library candidate, else a synthetic lib:<id>. */
export function libraryMergeKey(c: {
  id: string;
  linkedinUrl: string | null;
  jobAdderUrl: string | null;
  seekUrl: string | null;
}): string {
  return (
    mergeKeyToString(
      identityMergeKey({ linkedinUrl: c.linkedinUrl, jobAdderUrl: c.jobAdderUrl, seekUrl: c.seekUrl }),
    ) ??
    `lib:${c.id}`
  );
}

/** Tier-1 merge key for a scraper hit, else a synthetic li:<normalisedUrl>. */
export function scraperMergeKey(args: {
  linkedinUrl?: string | null;
  jobAdderUrl?: string | null;
  seekUrl?: string | null;
  fallbackUrl: string;
}): string {
  return (
    mergeKeyToString(
      identityMergeKey({
        linkedinUrl: args.linkedinUrl,
        jobAdderUrl: args.jobAdderUrl,
        seekUrl: args.seekUrl,
      }),
    ) ?? `li:${args.fallbackUrl}`
  );
}

function mergeSources(existing: string[], add: SourceKey): string[] {
  return existing.includes(add) ? existing : [...existing, add];
}

// ── create ──────────────────────────────────────────────────────────────────

export interface CreateRunArgs {
  orgId: string | null;
  /** Set when the run is started from a job (durable job search); the job page
   *  resumes "this job's latest run" by it. null for the standalone /search page. */
  jobId?: string | null;
  requestedBy: string | null;
  rawQuery: string;
  parsedQuery: ParsedQuery;
  location: string | null;
  sources: SourceKey[];
  // Initial per-source statuses (caller decides based on what it will run).
  libraryStatus: SourceStatus;
  linkedinStatus: SourceStatus;
  seekStatus: SourceStatus;
}

export async function createRun(args: CreateRunArgs): Promise<{ id: string }> {
  const run = await prisma.searchRun.create({
    data: {
      orgId: args.orgId,
      jobId: args.jobId ?? null,
      requestedBy: args.requestedBy,
      rawQuery: args.rawQuery,
      parsedQuery: JSON.stringify(args.parsedQuery),
      location: args.location,
      sources: JSON.stringify(args.sources),
      status: "queued",
      libraryStatus: args.libraryStatus,
      linkedinStatus: args.linkedinStatus,
      seekStatus: args.seekStatus,
    },
    select: { id: true },
  });
  return run;
}

// ── attach: library (synchronous, at create time) ───────────────────────────

export async function attachLibraryResults(
  searchRunId: string,
  results: LibrarySearchResult[],
): Promise<void> {
  let rank = 0;
  for (const r of results) {
    rank += 1;
    const mergeKey = libraryMergeKey({
      id: r.id,
      linkedinUrl: r.linkedinUrl,
      jobAdderUrl: r.jobAdderUrl,
      seekUrl: r.seekUrl,
    });
    // ON CONFLICT merges the "library" source into any pre-existing row for
    // this key (none expected at create time, but keeps the path idempotent).
    await prisma.$executeRaw`
      INSERT INTO "SearchRunResult"
        ("id","searchRunId","mergeKey","sources","candidateId","candidateIdentityId",
         "profileUrl","name","headline","location","snippet","matchScore","relevance","rank",
         "createdAt","updatedAt")
      VALUES (${randomUUID()}, ${searchRunId}, ${mergeKey}, ${JSON.stringify(["library"])},
              ${r.id}, ${r.candidateIdentityId}, ${r.linkedinUrl}, ${r.name}, ${r.headline},
              ${r.location}, ${r.profileTextSnippet}, ${r.matchScore}, ${r.relevance}, ${rank},
              now(), now())
      ON CONFLICT ("searchRunId","mergeKey") DO UPDATE SET
        "candidateId"         = COALESCE("SearchRunResult"."candidateId", EXCLUDED."candidateId"),
        "candidateIdentityId" = COALESCE("SearchRunResult"."candidateIdentityId", EXCLUDED."candidateIdentityId"),
        "name"                = COALESCE("SearchRunResult"."name", EXCLUDED."name"),
        "headline"            = COALESCE("SearchRunResult"."headline", EXCLUDED."headline"),
        "matchScore"          = COALESCE("SearchRunResult"."matchScore", EXCLUDED."matchScore"),
        "relevance"           = COALESCE("SearchRunResult"."relevance", EXCLUDED."relevance"),
        "updatedAt"           = now()
    `;
  }
  await prisma.searchRun.update({
    where: { id: searchRunId },
    data: { libraryStatus: "complete" },
  });
  await recomputeCounts(searchRunId);
}

// ── attach: scraper search hits (URL harvest, candidateId still null) ────────

export interface ScraperCard {
  url: string;
  name?: string | null;
  headline?: string | null;
  location?: string | null;
  /** SEEK "Updated X ago" recency label, harvested verbatim. Additive/nullable;
   *  null for LinkedIn cards and SEEK harvests from a worker without the watch
   *  features. Profile-update-alert hit-detection parses this per-row. */
  updatedAgo?: string | null;
}

export async function attachScraperHits(args: {
  searchRunId: string;
  source: Extract<SourceKey, "linkedin" | "seek">;
  urls: string[];
  /** Per-URL card metadata harvested from the search results page, so rows
   *  show a real name/headline/location immediately instead of "fetching…". */
  cards?: ScraperCard[];
  /** True when the SOURCE already scoped the search to the run's location
   *  (SEEK picks the region in its own form; locationList= verified in the
   *  results URL). Skips the app-side card-location re-filter below. */
  sourceLocationApplied?: boolean;
}): Promise<void> {
  const cardByUrl = new Map((args.cards ?? []).map((c) => [c.url, c]));
  // Location gate: the scrape legs (LinkedIn/SEEK) return NZ-wide cards. Drop any
  // whose location doesn't match the run's requested location, so a "Wellington"
  // search can't surface Auckland/Christchurch profiles (the Library leg already
  // filters this way). "All NZ" runs (null location) keep everything.
  const run = await prisma.searchRun.findUnique({ where: { id: args.searchRunId }, select: { location: true, rawQuery: true } });
  const runLocation = run?.location ?? null;
  // Parse the run's query once so each unscored scraper card gets a cheap, local
  // relevance (0..1). This is what lets LinkedIn/SEEK rows interleave with the
  // scored library rows by quality instead of clumping at the bottom unranked
  // (loadRunSnapshot sorts by matchScore ?? relevance×100). It's a keyword
  // estimate, not a vetted score — so we set relevance, NOT matchScore.
  const parsedQuery = run?.rawQuery ? parseBooleanQuery(run.rawQuery) : null;
  for (const url of args.urls) {
    const mergeKey = scraperMergeKey({
      linkedinUrl: args.source === "linkedin" ? url : null,
      seekUrl: args.source === "seek" ? url : null,
      fallbackUrl: url,
    });
    const card = cardByUrl.get(url);
    // Skip the gate when the source already filtered server-side: re-filtering
    // SEEK's region-scoped results on the PARSED card location silently dropped
    // legit harvests whenever the card's location line didn't parse (null) or
    // used a suburb spelling locationMatches doesn't map — "SEEK harvested 100,
    // app showed a handful". The gate stays for LinkedIn (keyword-only search)
    // and for older workers that don't report the flag.
    if (!args.sourceLocationApplied && !locationMatches(card?.location, runLocation)) continue;
    // Guard the harvested card fields before they go RAW into SearchRunResult.
    // Search cards regularly leak nav/CTA text ("Message", "Connect"), a bare
    // company name, or a URL into these slots; storing that as the candidate's
    // name/headline is the "mumbled shit" we're stopping at the door.
    const name = looksLikeCapturedName(card?.name) ? card!.name! : null;
    const headline = sanitizeCardField(card?.headline);
    const location = sanitizeCardField(card?.location);
    // SEEK recency label, stored verbatim (the app parses it later). Always null
    // for LinkedIn and for SEEK harvests without the watch features.
    const updatedAgo = args.source === "seek" ? card?.updatedAgo ?? null : null;
    // Local relevance from the harvested card text (null if we couldn't parse
    // the query). COALESCE in the conflict clause means a pre-existing library
    // row keeps its own relevance — only a fresh scraper-only row takes this.
    const relevance = parsedQuery
      ? scoreTextRelevance(parsedQuery, [name, headline, location].filter(Boolean).join(" "))
      : null;
    await prisma.$executeRaw`
      INSERT INTO "SearchRunResult"
        ("id","searchRunId","mergeKey","sources","profileUrl","name","headline","location","updatedAgo","relevance","createdAt","updatedAt")
      VALUES (${randomUUID()}, ${args.searchRunId}, ${mergeKey},
              ${JSON.stringify([args.source])}, ${url}, ${name}, ${headline}, ${location}, ${updatedAgo}, ${relevance}, now(), now())
      ON CONFLICT ("searchRunId","mergeKey") DO UPDATE SET
        "sources"   = (
          SELECT to_jsonb(array(SELECT DISTINCT unnest(
            (SELECT array(SELECT jsonb_array_elements_text("SearchRunResult"."sources"::jsonb))) ||
            ARRAY[${args.source}]::text[]
          )))::text
        ),
        "profileUrl" = COALESCE("SearchRunResult"."profileUrl", EXCLUDED."profileUrl"),
        -- COALESCE preserves an existing (e.g. ingested) value; only fills gaps.
        "name"       = COALESCE("SearchRunResult"."name", EXCLUDED."name"),
        "headline"   = COALESCE("SearchRunResult"."headline", EXCLUDED."headline"),
        "location"   = COALESCE("SearchRunResult"."location", EXCLUDED."location"),
        -- Recency refreshes: a re-harvest carries a newer "Updated X ago" label,
        -- so take the latest non-null rather than pinning the first-seen value.
        "updatedAgo" = COALESCE(EXCLUDED."updatedAgo", "SearchRunResult"."updatedAgo"),
        "relevance"  = COALESCE("SearchRunResult"."relevance", EXCLUDED."relevance"),
        "updatedAt"  = now()
    `;
  }
  await recomputeCounts(args.searchRunId);
}

// ── attach: ingested profile (reconcile against the library row) ─────────────

export async function attachIngestedProfile(args: {
  searchRunId: string;
  candidateId: string;
  candidateIdentityId: string | null;
  mergeKey: string;
  source: Extract<SourceKey, "linkedin" | "seek">;
  profileUrl: string | null;
  name: string | null;
  headline: string | null;
  location: string | null;
  snippet: string | null;
}): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      // 1. Already a row for this resolved candidate (the library hit)?
      const existing = await tx.searchRunResult.findFirst({
        where: { searchRunId: args.searchRunId, candidateId: args.candidateId },
        select: { id: true, mergeKey: true, sources: true },
      });
      if (existing) {
        const sources = mergeSources(safeArray(existing.sources), args.source);
        await tx.searchRunResult.update({
          where: { id: existing.id },
          data: {
            sources: JSON.stringify(sources),
            profileUrl: args.profileUrl ?? undefined,
          },
        });
        // Drop the standalone scraper-hit row now that it merged in.
        if (existing.mergeKey !== args.mergeKey) {
          await tx.searchRunResult.deleteMany({
            where: { searchRunId: args.searchRunId, mergeKey: args.mergeKey, candidateId: null },
          });
        }
        return;
      }
      // 2. No library row — upsert on (searchRunId, mergeKey). Raw ON CONFLICT
      //    so concurrent attaches merge instead of one throwing P2002.
      await tx.$executeRaw`
        INSERT INTO "SearchRunResult"
          ("id","searchRunId","mergeKey","sources","candidateId","candidateIdentityId",
           "profileUrl","name","headline","location","snippet","createdAt","updatedAt")
        VALUES (${randomUUID()}, ${args.searchRunId}, ${args.mergeKey},
                ${JSON.stringify([args.source])}, ${args.candidateId}, ${args.candidateIdentityId},
                ${args.profileUrl}, ${args.name}, ${args.headline}, ${args.location}, ${args.snippet},
                now(), now())
        ON CONFLICT ("searchRunId","mergeKey") DO UPDATE SET
          "candidateId"         = COALESCE("SearchRunResult"."candidateId", EXCLUDED."candidateId"),
          "candidateIdentityId" = COALESCE("SearchRunResult"."candidateIdentityId", EXCLUDED."candidateIdentityId"),
          "name"                = COALESCE("SearchRunResult"."name", EXCLUDED."name"),
          "headline"            = COALESCE("SearchRunResult"."headline", EXCLUDED."headline"),
          "location"            = COALESCE("SearchRunResult"."location", EXCLUDED."location"),
          "snippet"             = COALESCE("SearchRunResult"."snippet", EXCLUDED."snippet"),
          "updatedAt"           = now()
      `;
    },
    { isolationLevel: "ReadCommitted" },
  );
  await recomputeCounts(args.searchRunId);
}

function safeArray(json: string): SourceKey[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as SourceKey[]) : [];
  } catch {
    return [];
  }
}

// ── counts ──────────────────────────────────────────────────────────────────

/** Recompute per-source + total + deduped counts from result rows. Idempotent. */
export async function recomputeCounts(searchRunId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "SearchRun" SET
      "libraryCount"  = (SELECT count(*) FROM "SearchRunResult" WHERE "searchRunId"=${searchRunId} AND "sources"::jsonb ? 'library'),
      "linkedinCount" = (SELECT count(*) FROM "SearchRunResult" WHERE "searchRunId"=${searchRunId} AND "sources"::jsonb ? 'linkedin'),
      "seekCount"     = (SELECT count(*) FROM "SearchRunResult" WHERE "searchRunId"=${searchRunId} AND "sources"::jsonb ? 'seek'),
      "totalCount"    = (SELECT count(*) FROM "SearchRunResult" WHERE "searchRunId"=${searchRunId}),
      "dedupedCount"  = GREATEST(0,
        (SELECT count(*) FROM "SearchRunResult" WHERE "searchRunId"=${searchRunId} AND "sources"::jsonb ? 'library') +
        (SELECT count(*) FROM "SearchRunResult" WHERE "searchRunId"=${searchRunId} AND "sources"::jsonb ? 'linkedin') +
        (SELECT count(*) FROM "SearchRunResult" WHERE "searchRunId"=${searchRunId} AND "sources"::jsonb ? 'seek') -
        (SELECT count(*) FROM "SearchRunResult" WHERE "searchRunId"=${searchRunId})),
      "updatedAt"     = now()
    WHERE "id"=${searchRunId}
  `;
}

/** Set one source's status column (single-column write — no JSON race). */
export async function setSourceStatus(
  searchRunId: string,
  source: SourceKey,
  status: SourceStatus,
): Promise<void> {
  const col = source === "library" ? "libraryStatus" : source === "linkedin" ? "linkedinStatus" : "seekStatus";
  // Column name is from a closed enum, never user input — safe to interpolate.
  await prisma.$executeRawUnsafe(
    `UPDATE "SearchRun" SET "${col}"=$1, "updatedAt"=now() WHERE "id"=$2`,
    status,
    searchRunId,
  );
}

// ── completion (atomic last-child transition) ────────────────────────────────

/**
 * Idempotent, concurrency-safe. Serializes per-run via SELECT ... FOR UPDATE
 * so concurrent child PATCHes can't deadlock into a no-flip. Returns true if
 * this call flipped the run terminal.
 */
export async function settleRunIfDone(searchRunId: string): Promise<boolean> {
  return prisma.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<{ id: string; status: string }[]>`
        SELECT "id","status" FROM "SearchRun" WHERE "id"=${searchRunId} FOR UPDATE
      `;
      const run = locked[0];
      if (!run) return false;
      if (["complete", "partial", "failed"].includes(run.status)) return false;

      const inflight = await tx.scrapeJob.count({
        where: { searchRunId, status: { in: ["pending", "processing"] } },
      });
      if (inflight > 0) return false;

      const [failed, completed, runRow] = await Promise.all([
        tx.scrapeJob.count({ where: { searchRunId, status: "failed" } }),
        tx.scrapeJob.count({ where: { searchRunId, status: "completed" } }),
        tx.searchRun.findUnique({ where: { id: searchRunId }, select: { libraryCount: true } }),
      ]);
      const libraryCount = runRow?.libraryCount ?? 0;

      // failed ONLY when nothing succeeded AND the library delivered nothing —
      // a lone failed search job must not nuke a run with durable library hits.
      const terminal: RunStatus =
        failed > 0 && completed === 0 && libraryCount === 0
          ? "failed"
          : failed > 0
            ? "partial"
            : "complete";

      // Settle any source pill still non-terminal. The normal path flips pills
      // in the worker's PATCH, but a job whose result PATCH never landed gets
      // reclaimed by the sweep straight to 'failed' — nothing flipped its pill,
      // so the UI showed a "processing" SEEK pill forever on a settled run
      // (observed live 2026-07-02). Derive from this run's child search jobs:
      // any completed harvest for the source → complete, else failed. One
      // statement for both pills — this runs inside the FOR UPDATE transaction,
      // so extra round-trips would eat into Prisma's interactive-tx window.
      await tx.$executeRaw`
        UPDATE "SearchRun" SET
          "linkedinStatus" = CASE WHEN "linkedinStatus" IN ('pending','running') THEN
              CASE WHEN EXISTS (SELECT 1 FROM "ScrapeJob" WHERE "searchRunId"=${searchRunId} AND "platform"='linkedin' AND "kind"='search' AND "status"='completed')
                   THEN 'complete' ELSE 'failed' END
            ELSE "linkedinStatus" END,
          "seekStatus" = CASE WHEN "seekStatus" IN ('pending','running') THEN
              CASE WHEN EXISTS (SELECT 1 FROM "ScrapeJob" WHERE "searchRunId"=${searchRunId} AND "platform"='seek' AND "kind"='search' AND "status"='completed')
                   THEN 'complete' ELSE 'failed' END
            ELSE "seekStatus" END
        WHERE "id"=${searchRunId}
      `;

      await tx.searchRun.update({
        where: { id: searchRunId },
        data: { status: terminal, completedAt: new Date() },
      });
      return true;
    },
    // ~6 serialized statements run inside this tx; Prisma's default 5s
    // interactive-tx window is too tight on a high-latency link (settle runs
    // sub-second on Railway's internal network, but the smoke suite runs it
    // over the public proxy). Generous timeout, same behaviour.
    { isolationLevel: "ReadCommitted", maxWait: 10_000, timeout: 30_000 },
  );
}

// ── stale-job reclaim + stuck-run sweep ──────────────────────────────────────

/** Bounce ScrapeJobs stuck in 'processing' past the staleness window. Also
 *  fails any stray legacy kind='score' job (the Llama offload was removed
 *  2026-07-04 — nothing enqueues score jobs, and no worker processes them). */
export async function reclaimStaleJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_PROCESSING_MS);
  const retryable = await prisma.$executeRaw`
    UPDATE "ScrapeJob"
       SET "status"='pending', "retryCount"="retryCount"+1, "updatedAt"=now()
     WHERE "status"='processing' AND "kind" <> 'score' AND "updatedAt" < ${cutoff} AND "retryCount" < ${MAX_RETRIES}
  `;
  const exhausted = await prisma.$executeRaw`
    UPDATE "ScrapeJob"
       SET "status"='failed', "error"=COALESCE("error",'reclaimed: worker stalled'), "updatedAt"=now()
     WHERE "status"='processing' AND "kind" <> 'score' AND "updatedAt" < ${cutoff} AND "retryCount" >= ${MAX_RETRIES}
  `;
  // One-time drain: fail any legacy score job left pending/processing so it
  // can't strand a candidate as "queued" now that nothing completes it.
  const strayScore = await prisma.$executeRaw`
    UPDATE "ScrapeJob"
       SET "status"='failed', "error"='score offload removed', "updatedAt"=now()
     WHERE "kind"='score' AND "status" IN ('pending','processing')
  `;
  return Number(retryable) + Number(exhausted) + Number(strayScore);
}

/** Reclaim zombie children, re-drive abandoned queued runs, settle finished ones. */
export async function sweepStuckRuns(): Promise<{ reclaimed: number; swept: number }> {
  const reclaimed = await reclaimStaleJobs();

  // (a) queued runs with no enqueue (POST aborted mid-create) → terminal from library state.
  const stuckQueued = await prisma.searchRun.findMany({
    where: { status: "queued", createdAt: { lt: new Date(Date.now() - STUCK_QUEUED_MS) } },
    select: { id: true, libraryStatus: true },
  });
  for (const r of stuckQueued) {
    // Only force-terminal if no child jobs are attached (truly abandoned).
    const childCount = await prisma.scrapeJob.count({ where: { searchRunId: r.id } });
    if (childCount > 0) continue;
    await prisma.searchRun.updateMany({
      where: { id: r.id, status: "queued" },
      data: {
        status: r.libraryStatus === "complete" ? "complete" : "failed",
        error: r.libraryStatus === "complete" ? null : "Run abandoned before discovery enqueued",
        completedAt: new Date(),
      },
    });
  }

  // (b) running/queued runs whose children are all settled → settle.
  const candidates = await prisma.searchRun.findMany({
    where: { status: { in: ["queued", "running"] }, updatedAt: { lt: new Date(Date.now() - 60_000) } },
    select: { id: true },
  });
  let swept = 0;
  for (const r of candidates) if (await settleRunIfDone(r.id)) swept++;
  return { reclaimed, swept };
}

// ── snapshot / DTO ───────────────────────────────────────────────────────────

export interface SearchRunResultDTO {
  id: string;
  mergeKey: string;
  sources: SourceKey[];
  candidateId: string | null;
  candidateIdentityId: string | null;
  profileUrl: string | null;
  name: string | null;
  headline: string | null;
  location: string | null;
  snippet: string | null;
  matchScore: number | null;
  relevance: number | null;
  rank: number | null;
  photoUrl: string | null;
  /** SEEK "Updated X ago" recency label, harvested verbatim (null for LinkedIn
   *  and library rows). Lets result cards show how fresh a SEEK profile is — a
   *  strong buy signal for recruiters. Optional to match ScraperCard + keep
   *  existing DTO fixtures valid. */
  updatedAgo?: string | null;
}

export interface RunDTO {
  id: string;
  orgId: string | null;
  rawQuery: string;
  location: string | null;
  sources: SourceKey[];
  status: RunStatus;
  sourceStatus: { library: SourceStatus; linkedin: SourceStatus; seek: SourceStatus };
  counts: { library: number; linkedin: number; seek: number; deduped: number; total: number };
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  updatedAtMs: number;
}

export interface RunSnapshot {
  run: RunDTO;
  results?: SearchRunResultDTO[];
}

function toRunDTO(run: {
  id: string; orgId: string | null; rawQuery: string; location: string | null;
  sources: string; status: string; libraryStatus: string; linkedinStatus: string; seekStatus: string;
  libraryCount: number; linkedinCount: number; seekCount: number; dedupedCount: number; totalCount: number;
  error: string | null; createdAt: Date; completedAt: Date | null; updatedAt: Date;
}): RunDTO {
  return {
    id: run.id,
    orgId: run.orgId,
    rawQuery: run.rawQuery,
    location: run.location,
    sources: safeArray(run.sources),
    status: run.status as RunStatus,
    sourceStatus: {
      library: run.libraryStatus as SourceStatus,
      linkedin: run.linkedinStatus as SourceStatus,
      seek: run.seekStatus as SourceStatus,
    },
    counts: {
      library: run.libraryCount,
      linkedin: run.linkedinCount,
      seek: run.seekCount,
      deduped: run.dedupedCount,
      total: run.totalCount,
    },
    error: run.error,
    createdAt: run.createdAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    updatedAtMs: run.updatedAt.getTime(),
  };
}

/**
 * Load a run + its results for the page / SSE. When `sinceUpdatedAt` is given
 * and the run hasn't changed since, the `results` array is omitted so the SSE
 * tick stays cheap (just the run row + counts).
 */
export async function loadRunSnapshot(
  runId: string,
  opts: { sinceUpdatedAt?: number } = {},
): Promise<RunSnapshot | null> {
  const run = await prisma.searchRun.findUnique({ where: { id: runId } });
  if (!run) return null;
  const dto = toRunDTO(run);

  if (opts.sinceUpdatedAt !== undefined && dto.updatedAtMs === opts.sinceUpdatedAt) {
    return { run: dto }; // unchanged — omit results
  }

  const rows = await prisma.searchRunResult.findMany({
    where: { searchRunId: runId },
    // Base fetch order only; the authoritative unified ranking (matchScore for
    // scored library rows, relevance×100 for unscored scraper cards, on ONE
    // axis) is applied in JS below — Prisma can't COALESCE across the two.
    orderBy: [{ matchScore: "desc" }, { relevance: "desc" }, { rank: "asc" }],
  });

  // Batch-fetch photoFileId for the candidate-backed rows so result cards can
  // show avatars (getCandidatePhotoUrl needs both candidateId + photoFileId).
  const candidateIds = rows.map((r) => r.candidateId).filter((id): id is string => !!id);
  const photoByCandidate = new Map<string, string | null>();
  if (candidateIds.length > 0) {
    const cands = await prisma.candidate.findMany({
      where: { id: { in: candidateIds } },
      select: { id: true, photoFileId: true },
    });
    for (const c of cands) photoByCandidate.set(c.id, c.photoFileId);
  }

  const results: SearchRunResultDTO[] = rows.map((r) => ({
    id: r.id,
    mergeKey: r.mergeKey,
    sources: safeArray(r.sources),
    candidateId: r.candidateId,
    candidateIdentityId: r.candidateIdentityId,
    profileUrl: r.profileUrl,
    name: r.name,
    headline: r.headline,
    location: r.location,
    snippet: r.snippet,
    matchScore: r.matchScore,
    relevance: r.relevance,
    rank: r.rank,
    updatedAgo: r.updatedAgo,
    photoUrl: getCandidatePhotoUrl({
      candidateId: r.candidateId,
      photoFileId: r.candidateId ? photoByCandidate.get(r.candidateId) ?? null : null,
    }),
  }));
  // Unified ranking across sources: a scored library row sorts by its matchScore
  // (0-100); an unscored LinkedIn/SEEK card sorts by its local relevance scaled
  // to the same axis (×100). This interleaves all sources by match quality
  // instead of the old rank-first ordering that dumped every unscored scraper
  // row below the entire library block. Ties: a vetted score beats an equal
  // estimate; then library rank; then id for stability.
  const unifiedKey = (r: SearchRunResultDTO) =>
    r.matchScore ?? Math.round((r.relevance ?? 0) * 100);
  results.sort((a, b) => {
    const diff = unifiedKey(b) - unifiedKey(a);
    if (diff !== 0) return diff;
    const vetted = (a.matchScore !== null ? 1 : 0) - (b.matchScore !== null ? 1 : 0);
    if (vetted !== 0) return -vetted;
    const ar = a.rank ?? Number.MAX_SAFE_INTEGER;
    const br = b.rank ?? Number.MAX_SAFE_INTEGER;
    if (ar !== br) return ar - br;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return { run: dto, results };
}

/** Map a worker-side scrape platform to a SearchRun source key. */
export function platformToSource(platform: string): Extract<SourceKey, "linkedin" | "seek"> | null {
  if (platform === "linkedin") return "linkedin";
  if (platform === "seek") return "seek";
  return null;
}

/**
 * Access check for GET /api/search/[runId] + /stream. Returns true if the
 * caller may view the run: owners see all; everyone else only runs whose
 * orgId is in their accessible set. 404 (not 403) on miss — don't leak
 * existence. `accessibleOrgIds === null` means owner (no scope filter).
 */
export async function assertRunAccess(
  runId: string,
  ctx: { isOwner: boolean; accessibleOrgIds: string[] | null },
): Promise<boolean> {
  const run = await prisma.searchRun.findUnique({ where: { id: runId }, select: { orgId: true } });
  if (!run) return false;
  if (ctx.isOwner || ctx.accessibleOrgIds === null) return true;
  return run.orgId !== null && ctx.accessibleOrgIds.includes(run.orgId);
}
