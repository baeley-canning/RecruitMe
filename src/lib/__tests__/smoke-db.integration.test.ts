/**
 * Real-Postgres smoke test — the deploy gate.
 *
 * The unit suite mocks `@/lib/db`, so raw-SQL type errors (e.g. the
 * `left(text, bigint)` regression that surfaced as "Library · failed")
 * slip straight through to production. This file does the opposite: it
 * runs the ACTUAL query functions against the REAL database so any
 * statement Postgres would reject fails the deploy instead of the user.
 *
 * It is INERT in the normal test run — every test is skipped unless
 * `SMOKE_DB=1` is set AND a DATABASE_URL is present. The deploy sequence
 * runs it after `npm run build`, before restarting the app:
 *
 *   set -a; . /etc/recruitme/app.env; set +a; npm run smoke:db
 *
 * Writes happen against a single throwaway SearchRun that is deleted in
 * afterAll (cascade removes its result rows), so it never pollutes data.
 * Reads (searchLibrary, getLibraryCandidates, collectBoxStats) are
 * non-mutating.
 *
 * NOTE: this file must NOT vi.mock("@/lib/db") — it needs the real client.
 */

import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { parseBooleanQuery } from "@/lib/boolean-query";
import { searchLibrary } from "@/lib/talent-search/library";
import { getLibraryCandidates } from "@/lib/library";
import { collectBoxStats } from "@/lib/box-stats";
import { claimScrapeJobs } from "@/lib/scrape-queue";
import {
  createRun,
  attachLibraryResults,
  attachScraperHits,
  attachIngestedProfile,
  recomputeCounts,
  setSourceStatus,
  settleRunIfDone,
  loadRunSnapshot,
  sweepStuckRuns,
} from "@/lib/search-run";
import type { LibrarySearchResult } from "@/lib/talent-search/library";

const ENABLED = process.env.SMOKE_DB === "1" && !!process.env.DATABASE_URL;
const d = ENABLED ? describe : describe.skip;

// Track temp rows for cleanup so a mid-test failure still tidies up.
const createdRunIds: string[] = [];
// Sentinel so the concurrent-claim test's jobs are isolated + always cleaned.
const CLAIM_TEST_MARKER = "__smoke_claim_test__";

afterAll(async () => {
  for (const id of createdRunIds) {
    await prisma.searchRun.delete({ where: { id } }).catch(() => {});
  }
  await prisma.scrapeJob.deleteMany({ where: { requestedBy: CLAIM_TEST_MARKER } }).catch(() => {});
  await prisma.$disconnect().catch(() => {});
});

d("smoke: searchLibrary FTS (the path that broke with left(text,bigint))", () => {
  it("phrase + AND with a location filter runs without a Postgres error", async () => {
    const results = await searchLibrary({
      parsedQuery: parseBooleanQuery('"business analyst" AND oracle'),
      accessibleOrgIds: null,
      location: "Wellington",
      limit: 5,
    });
    expect(Array.isArray(results)).toBe(true);
    // Snippets must come back as strings (LEFT(...)::int) or null, never throw.
    for (const r of results) {
      expect(r.profileTextSnippet === null || typeof r.profileTextSnippet === "string").toBe(true);
    }
  });

  it("OR / NOT / multi-word phrase variants all emit valid to_tsquery", async () => {
    for (const q of [
      "(java OR python) AND senior NOT junior",
      '"machine learning" OR "data science"',
      "react NOT contractor",
      "c++",            // tsquery-reserved chars must be stripped, not crash
      "node:* python",  // colon/asterisk hazard
    ]) {
      const out = await searchLibrary({
        parsedQuery: parseBooleanQuery(q),
        accessibleOrgIds: null,
        limit: 3,
      });
      expect(Array.isArray(out)).toBe(true);
    }
  });

  it("empty query takes the recency path without error", async () => {
    const out = await searchLibrary({ parsedQuery: parseBooleanQuery(""), accessibleOrgIds: null, limit: 5 });
    expect(Array.isArray(out)).toBe(true);
  });
});

d("smoke: getLibraryCandidates (library SSR prefilter raw SQL)", () => {
  it("loads a page without a Postgres error", async () => {
    // Owner auth shape — getLibraryCandidates only reads auth.isOwner/orgId.
    const res = await getLibraryCandidates(
      { userId: "smoke", orgId: null, isOwner: true } as Parameters<typeof getLibraryCandidates>[0],
      { take: 5 },
    );
    expect(Array.isArray(res.candidates)).toBe(true);
  });
});

d("smoke: collectBoxStats (box-dashboard raw queries + /proc)", () => {
  it("collects without error", async () => {
    const stats = await collectBoxStats();
    expect(stats.services.db.ok).toBe(true);
    expect(stats.today).toBeDefined();
    expect(typeof stats.scraper.queueDepth).toBe("number");
  });
});

d("smoke: SearchRun write lifecycle (ON CONFLICT, jsonb merge, FOR UPDATE)", () => {
  it("create → attach (library+scraper+ingest) → recompute → settle → snapshot", async () => {
    const run = await createRun({
      orgId: null,
      requestedBy: "smoke",
      rawQuery: "__smoke_db_test__",
      parsedQuery: parseBooleanQuery("smoke test"),
      location: null,
      sources: ["library", "linkedin"],
      libraryStatus: "running",
      linkedinStatus: "running",
      seekStatus: "skipped",
    });
    createdRunIds.push(run.id);

    // attachLibraryResults — exercises the library ON CONFLICT insert + recomputeCounts (jsonb ?).
    const fakeLib: LibrarySearchResult = {
      id: "smoke-cand-1",
      name: "Smoke Test",
      headline: "QA",
      location: "Nowhere",
      linkedinUrl: "https://www.linkedin.com/in/smoke-db-test/",
      jobAdderUrl: null,
      photoFileId: null,
      matchScore: 70,
      source: "jobadder_import",
      profileTextSnippet: "smoke",
      candidateIdentityId: null,
      createdAt: new Date(),
      relevance: 0.5,
    };
    await attachLibraryResults(run.id, [fakeLib]);

    // attachScraperHits — exercises the jsonb sources-array merge ON CONFLICT.
    await attachScraperHits({
      searchRunId: run.id,
      source: "linkedin",
      urls: ["https://www.linkedin.com/in/smoke-scraper-1/", "https://www.linkedin.com/in/smoke-db-test/"],
    });

    // attachIngestedProfile — reconcile against the library row for the same URL key.
    await attachIngestedProfile({
      searchRunId: run.id,
      candidateId: "smoke-cand-1",
      candidateIdentityId: null,
      mergeKey: "linkedinUrl:https://www.linkedin.com/in/smoke-db-test",
      source: "linkedin",
      profileUrl: "https://www.linkedin.com/in/smoke-db-test/",
      name: "Smoke Test",
      headline: "QA",
      location: "Nowhere",
      snippet: "smoke",
    });

    await setSourceStatus(run.id, "linkedin", "complete");
    await recomputeCounts(run.id);
    await settleRunIfDone(run.id); // FOR UPDATE transaction

    const snap = await loadRunSnapshot(run.id);
    expect(snap).not.toBeNull();
    expect(snap!.run.id).toBe(run.id);
    expect(Array.isArray(snap!.results)).toBe(true);
  });
});

d("smoke: sweepStuckRuns (reclaim + settle raw SQL)", () => {
  it("runs the sweep without a Postgres error", async () => {
    const out = await sweepStuckRuns();
    expect(typeof out.reclaimed).toBe("number");
    expect(typeof out.swept).toBe("number");
  });
});

d("smoke: claimScrapeJobs (atomic FOR UPDATE SKIP LOCKED)", () => {
  it("concurrent claims return DISJOINT job sets (no double-claim)", async () => {
    // Seed pending jobs under a sentinel org so they're isolated. The
    // requestedBy marker guarantees afterAll cleans them even on failure. (A
    // host suffix on the platform allowlist keeps any worker that grabs one
    // between insert and claim from doing real work — but disjointness holds
    // regardless, since a worker-claimed row is no longer 'pending'.)
    const orgId = `${CLAIM_TEST_MARKER}_org`;
    const N = 12;
    await prisma.scrapeJob.createMany({
      data: Array.from({ length: N }, (_, i) => ({
        orgId,
        platform: "linkedin",
        kind: "profile",
        profileUrl: `https://www.linkedin.com/in/${CLAIM_TEST_MARKER}-${i}`,
        status: "pending",
        priority: i % 3 === 0 ? 100 : 0, // mix of live + background
        requestedBy: CLAIM_TEST_MARKER,
      })),
    });

    // Fire several claims concurrently — the race the old findMany→updateMany lost.
    const results = await Promise.all([
      claimScrapeJobs(orgId, 5),
      claimScrapeJobs(orgId, 5),
      claimScrapeJobs(orgId, 5),
      claimScrapeJobs(orgId, 5),
    ]);

    const allIds = results.flatMap((r) => r.map((j) => j.id));
    const uniqueIds = new Set(allIds);
    // The core invariant: no job was handed to two concurrent claimers.
    expect(uniqueIds.size).toBe(allIds.length);
    // And we never claimed more rows than we seeded.
    expect(allIds.length).toBeLessThanOrEqual(N);
    // Returned rows carry the fields the worker needs.
    for (const j of results.flat()) {
      expect(typeof j.id).toBe("string");
      expect(j.orgId).toBe(orgId);
      expect(typeof j.priority).toBe("number");
    }
  });
});
