/**
 * Integration tests for POST /api/ingest/candidates/batch — the
 * headless-scraper ingest path.
 *
 * Mocks prisma + session (verifyScraperAuth) + error-reporting. The URL
 * normaliser / validator helpers (linkedin, seek, identity-merge) are left
 * REAL so we exercise actual normalisation + drop-invalid behaviour.
 *
 * Covers:
 *   • Auth: 401 when no / invalid bearer token
 *   • Body: 422 on bad body (missing profiles, short profileText, oversize)
 *   • Create: new library row (jobId null, source "scraper", seekUrl persisted
 *     + normalised)
 *   • Dedup: update when a library row with the same linkedinUrl exists
 *   • SEEK-only profile path
 *   • Invalid URL dropped but row still created
 *   • No-identity-key row skipped
 *   • Per-row failure isolation (one throws → others succeed)
 *   • counts shape
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    candidate: {
      findFirst: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
  },
}));

const sessionMocks = vi.hoisted(() => ({
  verifyScraperAuth: vi.fn(),
  unauthorized: vi.fn(() => new Response(null, { status: 401 })),
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/session", () => sessionMocks);
vi.mock("@/lib/error-reporting", () => ({ reportError: vi.fn() }));

import { POST } from "@/app/api/ingest/candidates/batch/route";

beforeEach(() => {
  vi.clearAllMocks();
  sessionMocks.verifyScraperAuth.mockResolvedValue({ orgId: "org-A", tokenId: "tok-1" });
  // Default: no existing row → create path.
  dbMocks.prisma.candidate.findFirst.mockResolvedValue(null);
  dbMocks.prisma.candidate.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({ id: "new-cand", ...data }),
  );
  dbMocks.prisma.candidate.update.mockImplementation(
    async ({ where }: { where: { id: string } }) => ({ id: where.id }),
  );
});

function makeReq(body: unknown): Request {
  return new Request("http://test/api/ingest/candidates/batch", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer xyz" },
    body: JSON.stringify(body),
  });
}

function profile(over: Partial<Record<string, unknown>> = {}) {
  return {
    name: "Scraped Person",
    headline: "Senior Engineer",
    location: "Auckland",
    linkedinUrl: "https://www.linkedin.com/in/scraped-person",
    jobAdderUrl: null,
    seekUrl: null,
    profileText: "x".repeat(120),
    externalId: null,
    ...over,
  };
}

describe("ingest/batch — auth", () => {
  it("401 when verifyScraperAuth returns null (no/invalid token)", async () => {
    sessionMocks.verifyScraperAuth.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ profiles: [profile()] }));
    expect(res.status).toBe(401);
    expect(dbMocks.prisma.candidate.create).not.toHaveBeenCalled();
  });
});

describe("ingest/batch — body validation", () => {
  it("422 when profiles missing", async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(422);
  });

  it("422 when profiles is empty", async () => {
    const res = await POST(makeReq({ profiles: [] }));
    expect(res.status).toBe(422);
  });

  it("422 when profiles exceeds 200", async () => {
    const big = Array.from({ length: 201 }, () => profile());
    const res = await POST(makeReq({ profiles: big }));
    expect(res.status).toBe(422);
  });

  it("422 when profileText is present but under 50 chars", async () => {
    const res = await POST(makeReq({ profiles: [profile({ profileText: "too short" })] }));
    expect(res.status).toBe(422);
  });

  it("422 when name is empty", async () => {
    const res = await POST(makeReq({ profiles: [profile({ name: "" })] }));
    expect(res.status).toBe(422);
  });
});

describe("ingest/batch — create new library row", () => {
  it("creates with jobId null, source scraper, orgId from token", async () => {
    const res = await POST(makeReq({ profiles: [profile()] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      outcomes: Array<{ index: number; status: string; candidateId?: string }>;
      counts: Record<string, number>;
    };
    expect(body.counts).toEqual({ created: 1, updated: 0, skipped: 0, failed: 0, total: 1 });
    expect(body.outcomes[0]).toMatchObject({ index: 0, status: "created" });

    const call = dbMocks.prisma.candidate.create.mock.calls[0][0];
    expect(call.data.jobId).toBeNull();
    expect(call.data.orgId).toBe("org-A");
    expect(call.data.source).toBe("scraper");
    expect(call.data.status).toBe("new");
    expect(call.data.name).toBe("Scraped Person");
    // linkedinUrl normalised.
    expect(call.data.linkedinUrl).toBe("https://www.linkedin.com/in/scraped-person");
  });

  it("persists a normalised seekUrl on a SEEK-only profile", async () => {
    const res = await POST(
      makeReq({
        profiles: [
          profile({
            linkedinUrl: null,
            jobAdderUrl: null,
            seekUrl: "https://www.seek.co.nz/profile/JaneDoe-123/?tracking=foo",
          }),
        ],
      }),
    );
    expect(res.status).toBe(200);
    const call = dbMocks.prisma.candidate.create.mock.calls[0][0];
    // Normalised: query stripped, host lowercased, path case preserved.
    expect(call.data.seekUrl).toBe("https://www.seek.co.nz/profile/JaneDoe-123");
    expect(call.data.linkedinUrl).toBeNull();
    // Lookup was scoped by the seekUrl key, jobId null, org.
    const lookup = dbMocks.prisma.candidate.findFirst.mock.calls[0][0];
    expect(lookup.where).toMatchObject({
      orgId: "org-A",
      jobId: null,
      seekUrl: "https://www.seek.co.nz/profile/JaneDoe-123",
    });
  });
});

describe("ingest/batch — dedup", () => {
  it("updates an existing library row with the same linkedinUrl (fill-only)", async () => {
    dbMocks.prisma.candidate.findFirst.mockResolvedValueOnce({
      id: "existing-1",
      headline: null,
      location: "Auckland",
      linkedinUrl: "https://www.linkedin.com/in/scraped-person",
      jobAdderUrl: null,
      seekUrl: null,
      profileText: "already has a long existing profile text here for sure",
    });

    const res = await POST(
      makeReq({
        profiles: [profile({ headline: "New Headline", profileText: "x".repeat(120) })],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { counts: Record<string, number> };
    expect(body.counts).toMatchObject({ created: 0, updated: 1, total: 1 });

    expect(dbMocks.prisma.candidate.create).not.toHaveBeenCalled();
    const call = dbMocks.prisma.candidate.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: "existing-1" });
    // Empty headline gets filled...
    expect(call.data.headline).toBe("New Headline");
    // ...but populated profileText is NOT clobbered.
    expect(call.data.profileText).toBeUndefined();
    // ...and a populated location is left alone.
    expect(call.data.location).toBeUndefined();
    expect(call.data.source).toBe("scraper");
  });
});

describe("ingest/batch — URL validation", () => {
  it("drops an invalid linkedinUrl but still creates the row via another key", async () => {
    const res = await POST(
      makeReq({
        profiles: [
          profile({
            linkedinUrl: "https://example.com/not-a-profile",
            seekUrl: "https://www.seek.com.au/profile/Bob-9",
          }),
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcomes: Array<{ status: string }> };
    expect(body.outcomes[0].status).toBe("created");
    const call = dbMocks.prisma.candidate.create.mock.calls[0][0];
    // Invalid LinkedIn URL dropped...
    expect(call.data.linkedinUrl).toBeNull();
    // ...SEEK URL kept + normalised, used as the identity key.
    expect(call.data.seekUrl).toBe("https://www.seek.com.au/profile/Bob-9");
  });
});

describe("ingest/batch — no identity key", () => {
  it("skips a profile with no usable URL (even with externalId)", async () => {
    const res = await POST(
      makeReq({
        profiles: [
          profile({
            linkedinUrl: null,
            jobAdderUrl: null,
            seekUrl: null,
            externalId: "ext-123",
          }),
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      outcomes: Array<{ status: string; reason?: string }>;
      counts: Record<string, number>;
    };
    expect(body.outcomes[0]).toMatchObject({ status: "skipped", reason: "no_identity_key" });
    expect(body.counts).toMatchObject({ skipped: 1, created: 0, total: 1 });
    expect(dbMocks.prisma.candidate.create).not.toHaveBeenCalled();
    expect(dbMocks.prisma.candidate.findFirst).not.toHaveBeenCalled();
  });
});

describe("ingest/batch — per-row failure isolation + counts", () => {
  it("one row throws, others continue", async () => {
    dbMocks.prisma.candidate.create
      .mockRejectedValueOnce(new Error("DB write error"))
      .mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "ok-2",
        ...data,
      }));

    const res = await POST(
      makeReq({
        profiles: [
          profile({ linkedinUrl: "https://www.linkedin.com/in/bad-one" }),
          profile({ linkedinUrl: "https://www.linkedin.com/in/good-one" }),
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      outcomes: Array<{ index: number; status: string; reason?: string }>;
      counts: Record<string, number>;
    };
    expect(body.counts).toEqual({ created: 1, updated: 0, skipped: 0, failed: 1, total: 2 });
    expect(body.outcomes[0]).toMatchObject({ index: 0, status: "failed", reason: "DB write error" });
    expect(body.outcomes[1]).toMatchObject({ index: 1, status: "created" });
  });

  it("returns full counts shape on mixed outcomes", async () => {
    // Row 0: created. Row 1: existing → updated. Row 2: no key → skipped.
    dbMocks.prisma.candidate.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "ex-1",
        headline: "H",
        location: "L",
        linkedinUrl: "https://www.linkedin.com/in/two",
        jobAdderUrl: null,
        seekUrl: null,
        profileText: "p".repeat(60),
      });

    const res = await POST(
      makeReq({
        profiles: [
          profile({ linkedinUrl: "https://www.linkedin.com/in/one" }),
          profile({ linkedinUrl: "https://www.linkedin.com/in/two" }),
          profile({ linkedinUrl: null, jobAdderUrl: null, seekUrl: null }),
        ],
      }),
    );
    const body = (await res.json()) as { counts: Record<string, number> };
    expect(body.counts).toEqual({ created: 1, updated: 1, skipped: 1, failed: 0, total: 3 });
  });
});
