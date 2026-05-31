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

import { describe, expect, it, vi } from "vitest";

// search-run.ts imports prisma at module load; stub it so the pure helpers
// can be imported without a DB.
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { libraryMergeKey, scraperMergeKey } from "../search-run";

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
