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
  failStaleScoreJobs,
} from "@/lib/search-run";
import type { LibrarySearchResult } from "@/lib/talent-search/library";

const ENABLED = process.env.SMOKE_DB === "1" && !!process.env.DATABASE_URL;
const d = ENABLED ? describe : describe.skip;

// Track temp rows for cleanup so a mid-test failure still tidies up.
const createdRunIds: string[] = [];
// Sentinel so the concurrent-claim test's jobs are isolated + always cleaned.
const CLAIM_TEST_MARKER = "__smoke_claim_test__";
// Sentinel for the Phase K fairness (priority + reserved slot) claim test.
const FAIRNESS_TEST_MARKER = "__smoke_fairness_test__";
// Sentinel for the Llama-offload score-job TTL sweep test.
const SCORE_TTL_MARKER = "__smoke_score_ttl_test__";
// Fixed ids for the currentInsightId FK behavioural test (deleted in afterAll
// too, in case the test is interrupted between create and the inline cleanup).
const FK_SMOKE_IDENTITY = "__smoke_fk_idty__";
const FK_SMOKE_INSIGHT = "__smoke_fk_insight__";
// Cross-org isolation probe: two orgs + a library candidate owned by org A.
const ISO_ORG_A = "__smoke_iso_org_a__";
const ISO_ORG_B = "__smoke_iso_org_b__";
const ISO_CAND = "__smoke_iso_cand__";
// Company-exclusion probe: one org + three candidates whose headlines pin the
// three behaviours the exclusion clause must get right (employer-anchored,
// role-text kept, metacharacters literal). See the matching describe block.
const EXC_ORG = "__smoke_exc_org__";
const EXC_EMP = "__smoke_exc_emp__";   // employed AT DNA → must be excluded
const EXC_ROLE = "__smoke_exc_role__"; // DNA in the ROLE, employed at Acme → kept
const EXC_META = "__smoke_exc_meta__"; // company name carries % / _ metacharacters

afterAll(async () => {
  for (const id of createdRunIds) {
    await prisma.searchRun.delete({ where: { id } }).catch(() => {});
  }
  await prisma.scrapeJob.deleteMany({ where: { requestedBy: { in: [CLAIM_TEST_MARKER, FAIRNESS_TEST_MARKER, SCORE_TTL_MARKER] } } }).catch(() => {});
  // Deleting the identity cascades its insights (identityId FK is CASCADE).
  await prisma.profileInsight.deleteMany({ where: { id: FK_SMOKE_INSIGHT } }).catch(() => {});
  await prisma.candidateIdentity.deleteMany({ where: { id: FK_SMOKE_IDENTITY } }).catch(() => {});
  await prisma.candidate.deleteMany({ where: { id: ISO_CAND } }).catch(() => {});
  await prisma.candidate.deleteMany({ where: { id: { in: [EXC_EMP, EXC_ROLE, EXC_META] } } }).catch(() => {});
  await prisma.org.deleteMany({ where: { id: { in: [ISO_ORG_A, ISO_ORG_B, EXC_ORG] } } }).catch(() => {});
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

d("smoke: searchLibrary company exclusion (the clause CI never exercised before)", () => {
  // df74924 shipped the exclusion clause but the smoke test only ever called
  // searchLibrary WITHOUT excludeCompanies, so the clause ran against Postgres
  // for the first time in PRODUCTION. A later review edit to that clause
  // (`LIKE ANY(...) ESCAPE '\'`) is a PARSE error Postgres rejects regardless of
  // input — tsc + the mocked unit suite pass it vacuously; only a real-DB run
  // with a non-empty list catches it. This test makes that run happen in CI and
  // pins the three behaviours the clause must hold.
  it("excludes employer matches, keeps role-text matches, treats metacharacters literally", async () => {
    await prisma.org.upsert({ where: { id: EXC_ORG }, update: {}, create: { id: EXC_ORG, name: EXC_ORG } });
    const seed = (id: string, headline: string) =>
      prisma.candidate.upsert({
        where: { id },
        update: { orgId: EXC_ORG, jobId: null, headline },
        create: {
          id, orgId: EXC_ORG, jobId: null, name: id, headline,
          linkedinUrl: `https://www.linkedin.com/in/${id}`, source: "manual", status: "new",
        },
      });
    await seed(EXC_EMP, "Principal Developer at DNA Design");
    await seed(EXC_ROLE, "DNA Sequencing Analyst at Acme Genomics");
    await seed(EXC_META, "Platform Engineer at 100%_Cloud");

    const ids = (rows: LibrarySearchResult[]) => new Set(rows.map((r) => r.id));
    const run = (exclude: string[]) =>
      searchLibrary({
        parsedQuery: parseBooleanQuery(""), // recency path — deterministic over the seeded org
        accessibleOrgIds: [EXC_ORG],
        excludeCompanies: exclude,
        limit: 50,
      });

    // Baseline: no exclusion → all three of the seeded candidates are visible.
    const baseline = ids(await run([]));
    expect(baseline.has(EXC_EMP) && baseline.has(EXC_ROLE) && baseline.has(EXC_META)).toBe(true);

    // Exclude "dna": drops the candidate EMPLOYED at DNA, KEEPS the one with DNA
    // only in the role title. A regression to unanchored substring matching
    // (the original review finding) would wrongly drop EXC_ROLE and fail here.
    const exDna = ids(await run(["dna"]));
    expect(exDna.has(EXC_EMP)).toBe(false);
    expect(exDna.has(EXC_ROLE)).toBe(true);

    // Metacharacters in a company name are matched LITERALLY. The exact name
    // excludes itself; a pattern that would only match if % / _ were SQL
    // wildcards must NOT exclude it. A regression to LIKE-with-wildcards (or the
    // ESCAPE-class parse error) would fail one of these two.
    expect(ids(await run(["100%_cloud"])).has(EXC_META)).toBe(false); // literal self-match → excluded
    expect(ids(await run(["1%d"])).has(EXC_META)).toBe(true);          // wildcard-only match → kept
  }, 30_000); // several round trips: seed + 5 searches. Generous for a WAN/CI Postgres.
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
  it("collects without error (now batched ≤4 queries at a time)", async () => {
    const stats = await collectBoxStats();
    expect(stats.services.db.ok).toBe(true);
    expect(stats.today).toBeDefined();
    expect(typeof stats.scraper.queueDepth).toBe("number");
  });
});

d("smoke: getLibraryCandidates pagination (SSR cap + cursor load-more)", () => {
  it("first page is capped and the cursor loads a DISJOINT next page (no vanish/repeat)", async () => {
    const auth = { userId: "smoke", orgId: null, isOwner: true } as Parameters<typeof getLibraryCandidates>[0];
    const page1 = await getLibraryCandidates(auth, { take: 3 });
    expect(Array.isArray(page1.candidates)).toBe(true);
    expect(page1.candidates.length).toBeLessThanOrEqual(3);
    // With a 14k library, a 3-row first page must expose a cursor to reach the rest.
    if (page1.candidates.length === 3) {
      expect(page1.nextCursor).not.toBeNull();
      const page2 = await getLibraryCandidates(auth, { cursor: page1.nextCursor!, take: 3 });
      const ids1 = new Set(page1.candidates.map((c) => c.id));
      // load-more must return NEW rows — candidates don't repeat or vanish across
      // pages. (Regressed once: an empty-array param on the owner path misaligned
      // the cursor bind, so page 2 silently re-returned page 1.)
      expect(page2.candidates.length).toBeGreaterThan(0);
      for (const c of page2.candidates) expect(ids1.has(c.id)).toBe(false);
    }
  });
});

d("smoke: cross-org library isolation (real DB — not a mocked where-clause)", () => {
  it("org B cannot see org A's library candidate; org A can", async () => {
    // The mocked unit tests only prove getLibraryCandidates was CALLED with an
    // orgId in the where-clause. The thing that actually leaks — a raw-SQL
    // prefilter that fails to bind orgId — is only catchable on Postgres. Seed
    // two orgs + one library candidate owned by A, then read as B.
    const orgA = await prisma.org.upsert({
      where: { id: ISO_ORG_A }, update: {},
      create: { id: ISO_ORG_A, name: ISO_ORG_A },
    });
    const orgB = await prisma.org.upsert({
      where: { id: ISO_ORG_B }, update: {},
      create: { id: ISO_ORG_B, name: ISO_ORG_B },
    });
    await prisma.candidate.upsert({
      where: { id: ISO_CAND }, update: { orgId: orgA.id },
      create: {
        id: ISO_CAND,
        orgId: orgA.id,
        jobId: null,
        name: "Isolation Probe",
        headline: "Senior Reliability Engineer",
        linkedinUrl: "https://www.linkedin.com/in/__smoke_iso_probe__",
        profileText:
          "Isolation Probe — Senior Reliability Engineer in Wellington with more " +
          "than a decade building distributed systems, on-call tooling, and " +
          "Postgres-backed services. Long enough to clear the library eligibility " +
          "prefilter so the org-B absence below is real isolation, not ineligibility.",
        source: "manual",
        status: "new",
      },
    });

    const asB = { userId: "smoke", orgId: orgB.id, isOwner: false } as Parameters<typeof getLibraryCandidates>[0];
    const seenByB = await getLibraryCandidates(asB, { take: 200 });
    expect(seenByB.candidates.some((c) => c.id === ISO_CAND)).toBe(false);

    const asA = { userId: "smoke", orgId: orgA.id, isOwner: false } as Parameters<typeof getLibraryCandidates>[0];
    const seenByA = await getLibraryCandidates(asA, { take: 200 });
    expect(seenByA.candidates.some((c) => c.id === ISO_CAND)).toBe(true);
  });
});

d("smoke: Candidate.seekUrl column (SEEK ingestion writes it on create/update)", () => {
  it("filters candidates by seekUrl without a Postgres error", async () => {
    // Proves the seekUrl column exists + is queryable on the real DB. The
    // scraper ingestion now stamps it on SEEK create AND update (it was
    // silently dropped before); the dedupe lookup also queries it. Unit tests
    // cover the write logic; this is the real-column existence gate. Non-mutating.
    const n = await prisma.candidate.count({ where: { seekUrl: { not: null } } });
    expect(typeof n).toBe("number");
    expect(n).toBeGreaterThanOrEqual(0);
  });
});

d("smoke: CandidateIdentity.currentInsightId FK (ON DELETE SET NULL)", () => {
  it("FK exists with SET NULL action and no dangling pointers remain", async () => {
    const fk = await prisma.$queryRaw<Array<{ confdeltype: string }>>`
      SELECT confdeltype FROM pg_constraint WHERE conname = 'CandidateIdentity_currentInsightId_fkey'
    `;
    expect(fk.length).toBe(1);
    // 'n' = ON DELETE SET NULL (vs 'c' cascade, 'a' no action, 'r' restrict).
    expect(fk[0].confdeltype).toBe("n");
    // The pre-null cleanup must have cleared any insight-deleted-before-FK rows.
    const dangling = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM "CandidateIdentity" ci
      WHERE ci."currentInsightId" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "ProfileInsight" pi WHERE pi."id" = ci."currentInsightId")
    `;
    expect(dangling[0].n).toBe(0);
  });

  it("deleting the pointed-to ProfileInsight nulls the pointer (SET NULL in action)", async () => {
    // CandidateIdentity.orgId → Org is an FK, so borrow an existing org.
    const org = await prisma.org.findFirst({ select: { id: true } });
    if (!org) return; // empty box — skip the behavioural leg, the FK-shape test still ran
    // Clean any leftovers from a prior interrupted run first (repeatable).
    await prisma.candidateIdentity.deleteMany({ where: { id: FK_SMOKE_IDENTITY } });
    await prisma.profileInsight.deleteMany({ where: { id: FK_SMOKE_INSIGHT } });

    await prisma.candidateIdentity.create({
      data: { id: FK_SMOKE_IDENTITY, orgId: org.id, canonicalName: "__smoke_fk__" },
    });
    await prisma.profileInsight.create({
      data: {
        id: FK_SMOKE_INSIGHT, orgId: org.id, identityId: FK_SMOKE_IDENTITY,
        factsJson: "{}", extractionVersion: 0, promptVersion: "smoke",
        extractedBy: "deterministic", modelId: "smoke", sourceProfileTextHash: "__smoke_fk_hash__",
      },
    });
    await prisma.candidateIdentity.update({
      where: { id: FK_SMOKE_IDENTITY }, data: { currentInsightId: FK_SMOKE_INSIGHT },
    });

    // Delete the insight → the FK must null the identity's pointer, not error.
    await prisma.profileInsight.delete({ where: { id: FK_SMOKE_INSIGHT } });
    const after = await prisma.candidateIdentity.findUnique({
      where: { id: FK_SMOKE_IDENTITY }, select: { currentInsightId: true },
    });
    expect(after?.currentInsightId).toBeNull();

    await prisma.candidateIdentity.delete({ where: { id: FK_SMOKE_IDENTITY } }).catch(() => {});
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
      seekUrl: null,
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
    // Llama-offload TTL is folded into the sweep the box already drives.
    expect(typeof out.scoreTimedOut).toBe("number");
  });
});

d("smoke: failStaleScoreJobs (Llama-offload TTL — real createdAt filtering)", () => {
  it("fails a 21-min-old pending score job but leaves a fresh one untouched", async () => {
    const orgId = `${SCORE_TTL_MARKER}_org`;
    // Clean any leftovers from a prior interrupted run.
    await prisma.scrapeJob.deleteMany({ where: { requestedBy: SCORE_TTL_MARKER } });

    // Stale: created 21 minutes ago, still pending → should be failed.
    const stale = await prisma.scrapeJob.create({
      data: {
        orgId, platform: "linkedin", kind: "score", candidateId: "ttl-stale-cand",
        scorePayload: "{}", status: "pending", priority: 0, requestedBy: SCORE_TTL_MARKER,
      },
      select: { id: true },
    });
    // createdAt has a DB default, so back-date it explicitly past the 20-min TTL.
    await prisma.$executeRaw`UPDATE "ScrapeJob" SET "createdAt" = now() - interval '21 minutes' WHERE "id" = ${stale.id}`;

    // Fresh: created now, pending → must NOT be touched.
    const fresh = await prisma.scrapeJob.create({
      data: {
        orgId, platform: "linkedin", kind: "score", candidateId: "ttl-fresh-cand",
        scorePayload: "{}", status: "pending", priority: 0, requestedBy: SCORE_TTL_MARKER,
      },
      select: { id: true },
    });

    const failedCount = await failStaleScoreJobs();
    expect(failedCount).toBeGreaterThanOrEqual(1);

    const staleAfter = await prisma.scrapeJob.findUnique({ where: { id: stale.id }, select: { status: true, error: true } });
    const freshAfter = await prisma.scrapeJob.findUnique({ where: { id: fresh.id }, select: { status: true } });
    expect(staleAfter?.status).toBe("failed");
    expect(staleAfter?.error).toMatch(/timed out/i);
    expect(freshAfter?.status).toBe("pending");

    await prisma.scrapeJob.deleteMany({ where: { requestedBy: SCORE_TTL_MARKER } });
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

d("smoke: claimScrapeJobs Phase K fairness (priority + reserved background slot)", () => {
  it("claims by priority but still reserves one slot for an older background job", async () => {
    // 4 live (priority 100) + 2 background (priority 0), all pending, isolated org.
    const orgId = `${FAIRNESS_TEST_MARKER}_org`;
    await prisma.scrapeJob.createMany({
      data: [
        ...Array.from({ length: 4 }, (_, i) => ({
          orgId, platform: "linkedin", kind: "profile",
          profileUrl: `https://www.linkedin.com/in/${FAIRNESS_TEST_MARKER}-live-${i}`,
          status: "pending", priority: 100, requestedBy: FAIRNESS_TEST_MARKER,
        })),
        ...Array.from({ length: 2 }, (_, i) => ({
          orgId, platform: "linkedin", kind: "profile",
          profileUrl: `https://www.linkedin.com/in/${FAIRNESS_TEST_MARKER}-bg-${i}`,
          status: "pending", priority: 0, requestedBy: FAIRNESS_TEST_MARKER,
        })),
      ],
    });

    // claimLimit=3 → priorityLimit=2 (two priority-100) + 1 reserved background.
    const claimed = await claimScrapeJobs(orgId, 3);
    expect(claimed.length).toBe(3);
    // The two highest-priority jobs were claimed…
    expect(claimed.filter((j) => j.priority === 100).length).toBe(2);
    // …and the reserved slot still pulled a background job through even though
    // four live jobs were waiting — live bursts can't fully starve discovery.
    expect(claimed.filter((j) => j.priority < 100).length).toBe(1);
  });
});
