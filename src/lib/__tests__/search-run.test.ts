/**
 * Unit tests for the durable-search merge-key helpers (Phase K).
 *
 * These pin the dedup contract that the whole run-result reconciliation
 * depends on: a library hit and a scraper hit for the SAME person must
 * produce the SAME merge key (so they collapse), and key-less rows must fall
 * back to distinct synthetic keys (so they don't collide).
 *
 * The DB-bound lifecycle (settleRunIfDone FOR UPDATE, sweep, attach*) is
 * exercised by the route/integration tests against a real Postgres; here we
 * lock the pure logic that has no I/O.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// search-run.ts imports prisma at module load; stub it so the pure helpers
// can be imported without a DB. $executeRaw is a spy so the attachScraperHits
// test can inspect the values bound into the INSERT (D1 card-field guards).
const dbMocks = vi.hoisted(() => ({
  prisma: {
    $executeRaw: vi.fn().mockResolvedValue(0),
    searchRun: { update: vi.fn().mockResolvedValue({}) },
  } as Record<string, unknown>,
}));
vi.mock("@/lib/db", () => dbMocks);

import { libraryMergeKey, scraperMergeKey, attachScraperHits, failStaleScoreJobs, reclaimStaleJobs } from "../search-run";

// Flatten a tagged-template's static-string array into one SQL string so a test
// can assert on the clauses it contains.
function sqlText(call: unknown[]): string {
  const strings = call[0] as TemplateStringsArray;
  return strings.join(" ").replace(/\s+/g, " ").trim();
}

describe("libraryMergeKey", () => {
  it("uses the LinkedIn URL when present (Tier-1)", () => {
    const key = libraryMergeKey({ id: "c1", linkedinUrl: "https://www.linkedin.com/in/jane-doe/", jobAdderUrl: null, seekUrl: null });
    expect(key.startsWith("linkedinUrl:")).toBe(true);
  });

  it("falls back to JobAdder URL when no LinkedIn", () => {
    const key = libraryMergeKey({ id: "c1", linkedinUrl: null, jobAdderUrl: "https://au6.jobadder.com/candidates/123", seekUrl: null });
    expect(key.startsWith("jobAdderUrl:")).toBe(true);
  });

  it("uses the SEEK URL when only seekUrl is present (Tier-1, lowest precedence)", () => {
    const key = libraryMergeKey({ id: "c1", linkedinUrl: null, jobAdderUrl: null, seekUrl: "https://talentsearch.seek.com.au/profile/abc" });
    expect(key.startsWith("seekUrl:")).toBe(true);
  });

  it("falls back to a synthetic lib:<id> when no Tier-1 key", () => {
    expect(libraryMergeKey({ id: "c1", linkedinUrl: null, jobAdderUrl: null, seekUrl: null })).toBe("lib:c1");
  });
});

describe("scraperMergeKey", () => {
  it("a LinkedIn scraper hit matches the library row's LinkedIn key", () => {
    const url = "https://www.linkedin.com/in/jane-doe/";
    const libKey = libraryMergeKey({ id: "c1", linkedinUrl: url, jobAdderUrl: null, seekUrl: null });
    const scrapeKey = scraperMergeKey({ linkedinUrl: url, fallbackUrl: url });
    expect(scrapeKey).toBe(libKey); // same person → same key → dedup collapses
  });

  it("a SEEK-only library row and a SEEK scraper hit for the same person collapse to one key", () => {
    // Finding 2: libraryMergeKey used to ignore seekUrl, so a SEEK-only library
    // row fell back to lib:<id> and never reconciled with the scraper's
    // seekUrl:<url> key — they became duplicate SearchRunResult rows for one
    // person. With seekUrl plumbed through, both sides produce the same key.
    const url = "https://talentsearch.seek.com.au/profile/abc";
    const libKey = libraryMergeKey({ id: "c1", linkedinUrl: null, jobAdderUrl: null, seekUrl: url });
    const scrapeKey = scraperMergeKey({ seekUrl: url, fallbackUrl: url });
    expect(libKey.startsWith("seekUrl:")).toBe(true);
    expect(scrapeKey).toBe(libKey); // same person → same key → dedup collapses
  });

  it("a SEEK scraper hit uses the seek Tier-1 key", () => {
    const url = "https://talentsearch.seek.com.au/profile/abc";
    const key = scraperMergeKey({ seekUrl: url, fallbackUrl: url });
    expect(key.startsWith("seekUrl:")).toBe(true);
  });

  it("falls back to a synthetic li:<url> when the URL isn't a recognised profile key", () => {
    const key = scraperMergeKey({ fallbackUrl: "https://example.com/x" });
    expect(key).toBe("li:https://example.com/x");
  });
});

describe("attachScraperHits — D1 card-field guards", () => {
  const executeRaw = dbMocks.prisma.$executeRaw as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    executeRaw.mockResolvedValue(0);
  });

  // The INSERT binds VALUES in this order:
  //   0 id, 1 searchRunId, 2 mergeKey, 3 sources, 4 url, 5 name, 6 headline, 7 location
  function insertedValuesForUrl(url: string): unknown[] | null {
    for (const call of executeRaw.mock.calls) {
      const values = call.slice(1); // drop the TemplateStringsArray
      if (values[4] === url) return values;
    }
    return null;
  }

  it("drops a junk card name (CTA/company text) but keeps a real name + headline", async () => {
    await attachScraperHits({
      searchRunId: "run-1",
      source: "linkedin",
      urls: ["https://www.linkedin.com/in/junk", "https://www.linkedin.com/in/real"],
      cards: [
        // Junk: name is an action-verb, headline is a URL, location is empty.
        { url: "https://www.linkedin.com/in/junk", name: "Connect", headline: "https://acme.example/jobs", location: "" },
        // Real: clean name, plausible headline + location survive verbatim.
        { url: "https://www.linkedin.com/in/real", name: "Jane Doe", headline: "Senior Engineer at Acme", location: "Auckland, New Zealand" },
      ],
    });

    const junk = insertedValuesForUrl("https://www.linkedin.com/in/junk");
    expect(junk).not.toBeNull();
    expect(junk![5]).toBeNull(); // name "Connect" rejected
    expect(junk![6]).toBeNull(); // URL headline dropped
    expect(junk![7]).toBeNull(); // empty location dropped

    const real = insertedValuesForUrl("https://www.linkedin.com/in/real");
    expect(real).not.toBeNull();
    expect(real![5]).toBe("Jane Doe");
    expect(real![6]).toBe("Senior Engineer at Acme");
    expect(real![7]).toBe("Auckland, New Zealand");
  });
});

describe("failStaleScoreJobs (Llama-offload TTL)", () => {
  const executeRaw = dbMocks.prisma.$executeRaw as ReturnType<typeof vi.fn>;
  beforeEach(() => {
    executeRaw.mockReset();
    executeRaw.mockResolvedValue(0);
  });

  it("issues one UPDATE failing pending|processing kind=score jobs past the TTL", async () => {
    executeRaw.mockResolvedValueOnce(3); // 3 stale score jobs failed
    const n = await failStaleScoreJobs();
    expect(n).toBe(3);
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const sql = sqlText(executeRaw.mock.calls[0]);
    // Targets ONLY score jobs, in either in-flight state, with the timeout
    // error text. createdAt cutoff is bound as a value (the `< ` before it).
    expect(sql).toContain(`"kind"='score'`);
    expect(sql).toContain(`"status" IN ('pending','processing')`);
    expect(sql).toMatch(/SET "status"='failed'/);
    expect(sql).toMatch(/timed out — local model unavailable/);
    expect(sql).toMatch(/"createdAt" </);
    // The bound cutoff is ~20 min in the past.
    const cutoff = executeRaw.mock.calls[0][1] as Date;
    const ageMs = Date.now() - cutoff.getTime();
    expect(ageMs).toBeGreaterThan(19 * 60 * 1000);
    expect(ageMs).toBeLessThan(21 * 60 * 1000);
  });
});

describe("reclaimStaleJobs excludes score jobs", () => {
  const executeRaw = dbMocks.prisma.$executeRaw as ReturnType<typeof vi.fn>;
  beforeEach(() => {
    executeRaw.mockReset();
    executeRaw.mockResolvedValue(0);
  });

  it("both reclaim UPDATEs scope to kind <> 'score' (TTL governs score jobs, not retry)", async () => {
    await reclaimStaleJobs();
    // Two UPDATEs: retryable requeue + exhausted fail. Both must skip score jobs
    // so the offload TTL — not the retry budget — owns their lifecycle.
    expect(executeRaw).toHaveBeenCalledTimes(2);
    for (const call of executeRaw.mock.calls) {
      expect(sqlText(call)).toContain(`"kind" <> 'score'`);
    }
  });
});
