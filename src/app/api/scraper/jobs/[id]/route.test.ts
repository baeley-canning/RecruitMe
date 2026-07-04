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
