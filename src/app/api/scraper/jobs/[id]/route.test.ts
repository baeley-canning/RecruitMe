/**
 * PATCH /api/scraper/jobs/[id] — kind="search" SEEK card ingestion.
 *
 * The box POSTs back harvested cards for a search job; Railway ingests each
 * SEEK card as a snippet candidate. LinkedIn searches deep-scrape profile
 * children instead, so their cards are NOT ingested here.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    scrapeJob: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      // enqueueScrapeJob (real, not mocked) dedups via findFirst then creates.
      // Without these the queue call swallowed its own TypeError and returned
      // null, so a broken enqueue would have looked like a passing test.
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "queued" }),
    },
    candidate: {
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  },
}));

// The route imports these at module load; stub so the import graph resolves
// without a DB.
const ingestionMocks = vi.hoisted(() => ({ ingestScraperResult: vi.fn() }));
const searchRunMocks = vi.hoisted(() => ({
  attachScraperHits: vi.fn(),
  attachIngestedProfile: vi.fn(),
  settleRunIfDone: vi.fn(),
  setSourceStatus: vi.fn(),
  scraperMergeKey: vi.fn(),
  platformToSource: vi.fn(),
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/scraper-ingestion", () => ingestionMocks);
vi.mock("@/lib/search-run", () => searchRunMocks);
vi.mock("@/lib/error-reporting", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/feature-flags", () => ({ isScraperEnabled: () => true }));

import { PATCH } from "./route";

const SECRET = "test-scraper-secret";

function searchJob(over: Record<string, unknown> = {}) {
  return {
    id: "job-search-1",
    orgId: "org-1",
    platform: "seek",
    kind: "search",
    profileUrl: null,
    searchQuery: "android kotlin",
    searchRunId: null,
    retryCount: 0,
    status: "processing",
    candidateId: null,
    scorePayload: null,
    ...over,
  };
}

function searchReq(id: string, body: unknown) {
  return new Request(`http://localhost/api/scraper/jobs/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "x-scraper-secret": SECRET },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/scraper/jobs/[id] — kind=search SEEK card ingestion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SCRAPER_SECRET = SECRET;
    dbMocks.prisma.scrapeJob.findFirst.mockResolvedValue(null);
    dbMocks.prisma.scrapeJob.create.mockResolvedValue({ id: "queued" });
    // The route reads .candidateId off the ingest result to queue the deep scrape.
    let n = 0;
    ingestionMocks.ingestScraperResult.mockImplementation(async () => ({
      candidateId: `cand-${++n}`,
      identityId: `ident-${n}`,
      identityAction: "created_new",
      candidateAction: "created_new",
    }));
  });

  const cards = [
    { url: "https://nz.employer.seek.com/talentsearch/profile/1", name: "Ada Lovelace", headline: "Senior Android Engineer", location: "Wellington, NZ" },
    { url: "https://nz.employer.seek.com/talentsearch/profile/2", name: "Alan Turing", headline: "Kotlin Developer", location: "Auckland, NZ" },
  ];

  it("ingests each harvested SEEK card as a snippet candidate (no searchRunId needed)", async () => {
    dbMocks.prisma.scrapeJob.findUnique.mockResolvedValue(searchJob());
    const res = await PATCH(
      searchReq("job-search-1", { status: "completed", result: { urls: cards.map((c) => c.url), cards } }),
      { params: Promise.resolve({ id: "job-search-1" }) },
    );
    expect(res.status).toBe(200);
    expect(ingestionMocks.ingestScraperResult).toHaveBeenCalledTimes(2);
    expect(ingestionMocks.ingestScraperResult).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        platform: "seek",
        profileUrl: "https://nz.employer.seek.com/talentsearch/profile/1",
        headline: "Senior Android Engineer",
        location: "Wellington, NZ",
      }),
    );
  });

  it("queues a deep profile scrape for each ingested SEEK card", async () => {
    // The whole point: a SEEK card is ~150 chars, which scores as "minimal".
    // Opening the profile is free, so the body text must actually be fetched.
    dbMocks.prisma.scrapeJob.findUnique.mockResolvedValue(searchJob());
    dbMocks.prisma.scrapeJob.findFirst.mockResolvedValue(null); // nothing in flight
    dbMocks.prisma.scrapeJob.create.mockResolvedValue({ id: "queued-1" });

    const res = await PATCH(
      searchReq("job-search-1", { status: "completed", result: { urls: cards.map((c) => c.url), cards } }),
      { params: Promise.resolve({ id: "job-search-1" }) },
    );
    expect(res.status).toBe(200);

    const profileJobs = dbMocks.prisma.scrapeJob.create.mock.calls
      .map((c: unknown[]) => (c[0] as { data: Record<string, unknown> }).data)
      .filter((d: Record<string, unknown>) => d.kind === "profile");
    expect(profileJobs).toHaveLength(2);
    expect(profileJobs.map((d: Record<string, unknown>) => d.profileUrl).sort()).toEqual(
      cards.map((c) => c.url).sort(),
    );
    // Each queued fetch must point at its OWN card, not the first one twice.
    expect(new Set(profileJobs.map((d: Record<string, unknown>) => d.profileUrl)).size).toBe(2);
    for (const d of profileJobs) {
      expect(d.platform).toBe("seek");
      expect(d.orgId).toBe("org-1");
    }
  });

  it("respects SEEK_DEEP_SCRAPE_PER_SEARCH as a bound on box time", async () => {
    process.env.SEEK_DEEP_SCRAPE_PER_SEARCH = "1";
    vi.resetModules();
    const { PATCH: BoundedPATCH } = await import("./route");

    dbMocks.prisma.scrapeJob.findUnique.mockResolvedValue(searchJob());
    dbMocks.prisma.scrapeJob.findFirst.mockResolvedValue(null);
    dbMocks.prisma.scrapeJob.create.mockResolvedValue({ id: "queued-1" });

    const res = await BoundedPATCH(
      searchReq("job-search-1", { status: "completed", result: { urls: cards.map((c) => c.url), cards } }),
      { params: Promise.resolve({ id: "job-search-1" }) },
    );
    expect(res.status).toBe(200);

    const profileJobs = dbMocks.prisma.scrapeJob.create.mock.calls
      .map((c: unknown[]) => (c[0] as { data: Record<string, unknown> }).data)
      .filter((d: Record<string, unknown>) => d.kind === "profile");
    // Both cards still become candidates; only ONE profile fetch is queued.
    expect(ingestionMocks.ingestScraperResult).toHaveBeenCalledTimes(2);
    expect(profileJobs).toHaveLength(1);

    delete process.env.SEEK_DEEP_SCRAPE_PER_SEARCH;
    vi.resetModules();
  });

  it("does NOT ingest cards for a LinkedIn search (LinkedIn deep-scrapes profile children instead)", async () => {
    dbMocks.prisma.scrapeJob.findUnique.mockResolvedValue(searchJob({ id: "job-search-li", platform: "linkedin" }));
    const res = await PATCH(
      searchReq("job-search-li", { status: "completed", result: { urls: ["https://linkedin.com/in/x"], cards: [{ url: "https://linkedin.com/in/x", name: "X", headline: "Dev", location: "NZ" }] } }),
      { params: Promise.resolve({ id: "job-search-li" }) },
    );
    expect(res.status).toBe(200);
    expect(ingestionMocks.ingestScraperResult).not.toHaveBeenCalled();
  });

  it("one malformed card does not fail the whole job", async () => {
    dbMocks.prisma.scrapeJob.findUnique.mockResolvedValue(searchJob());
    ingestionMocks.ingestScraperResult
      .mockRejectedValueOnce(new Error("bad card"))
      .mockResolvedValueOnce(undefined);
    const res = await PATCH(
      searchReq("job-search-1", { status: "completed", result: { urls: cards.map((c) => c.url), cards } }),
      { params: Promise.resolve({ id: "job-search-1" }) },
    );
    expect(res.status).toBe(200);
    expect(ingestionMocks.ingestScraperResult).toHaveBeenCalledTimes(2);
  });
});
