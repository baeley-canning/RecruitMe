/**
 * Integration tests for POST /api/jobs/[id]/search/multi/import.
 *
 * Mocks prisma + auth + org-access. Tests the per-row decision tree:
 *   • Auth (401/403)
 *   • Body validation (422 on missing results / bad rows / oversize batch)
 *   • Library-path import (copies source fields, scopes by org access)
 *   • LinkedIn-only-path import (normalised URL, snippet→profileText)
 *   • Cross-org library import (strips jobAdderUrl, denies if not accessible)
 *   • No-URL-key rows skipped with reason
 *   • Idempotent re-import (upsert keyed on jobId+linkedinUrl)
 *   • Per-row partial failure (one throws → others still attached)
 *   • Synthetic library:<id> key used when source has no linkedinUrl
 *   • Outcome + counts shape
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    candidate: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

const sessionMocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  requireJobAccess: vi.fn(),
  unauthorized: vi.fn(() => new Response(null, { status: 401 })),
}));

const orgAccessMocks = vi.hoisted(() => ({
  getAccessibleOrgIds: vi.fn(),
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/session", () => sessionMocks);
vi.mock("@/lib/org-access", () => orgAccessMocks);
vi.mock("@/lib/error-reporting", () => ({ reportError: vi.fn() }));

import { POST } from "@/app/api/jobs/[id]/search/multi/import/route";

beforeEach(() => {
  vi.clearAllMocks();
  sessionMocks.getAuth.mockResolvedValue({ userId: "u1", orgId: "org-A", isOwner: false });
  sessionMocks.requireJobAccess.mockResolvedValue({
    job: { id: "job-1", orgId: "org-A" },
    error: null,
  });
  orgAccessMocks.getAccessibleOrgIds.mockResolvedValue(["org-A"]);
  // Default upsert echoes back the create payload with a fresh id.
  dbMocks.prisma.candidate.upsert.mockImplementation(
    async ({ create }: { create: Record<string, unknown> }) => ({
      id: `new-${create.linkedinUrl}`,
      ...create,
    }),
  );
});

function makeReq(body: unknown): Request {
  return new Request("http://test/api/jobs/job-1/search/multi/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const PARAMS = { params: Promise.resolve({ id: "job-1" }) };

// Build an ImportRow matching the multi-search UnifiedResult subset.
function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "row-1",
    name: "Test Person",
    headline: "Engineer",
    location: "Wellington",
    linkedinUrl: "https://www.linkedin.com/in/test-person",
    jobAdderUrl: null,
    sources: ["linkedin"],
    candidateId: null,
    candidateIdentityId: null,
    snippet: "Snippet text from SerpAPI",
    ...over,
  };
}

describe("POST /search/multi/import — auth", () => {
  it("401 when not authenticated", async () => {
    sessionMocks.getAuth.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ results: [row()] }), PARAMS);
    expect(res.status).toBe(401);
    expect(dbMocks.prisma.candidate.upsert).not.toHaveBeenCalled();
  });

  it("returns requireJobAccess error when job is forbidden", async () => {
    sessionMocks.requireJobAccess.mockResolvedValueOnce({
      job: null,
      error: new Response(null, { status: 403 }),
    });
    const res = await POST(makeReq({ results: [row()] }), PARAMS);
    expect(res.status).toBe(403);
    expect(dbMocks.prisma.candidate.upsert).not.toHaveBeenCalled();
  });
});

describe("POST /search/multi/import — body validation", () => {
  it("422 when results missing", async () => {
    const res = await POST(makeReq({}), PARAMS);
    expect(res.status).toBe(422);
  });

  it("422 when results is empty", async () => {
    const res = await POST(makeReq({ results: [] }), PARAMS);
    expect(res.status).toBe(422);
  });

  it("accepts a large select-all batch (185 rows) — does NOT 422", async () => {
    // Regression: a 185-row "Select all" over library + LinkedIn + SEEK used to
    // hit the old max(100) and 422 — so nothing got added.
    const big = Array.from({ length: 185 }, (_, i) =>
      row({ id: `r-${i}`, sources: ["linkedin"], linkedinUrl: `https://www.linkedin.com/in/person-${i}` }),
    );
    const res = await POST(makeReq({ results: big }), PARAMS);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { counts: { attached: number; total: number } };
    expect(body.counts.total).toBe(185);
    expect(body.counts.attached).toBe(185);
    expect(dbMocks.prisma.candidate.upsert).toHaveBeenCalledTimes(185);
  });

  it("422 when results exceeds the 500 cap", async () => {
    const tooBig = Array.from({ length: 501 }, (_, i) => row({ id: `r-${i}` }));
    const res = await POST(makeReq({ results: tooBig }), PARAMS);
    expect(res.status).toBe(422);
  });

  it("422 when a row has invalid sources value", async () => {
    const res = await POST(
      makeReq({ results: [row({ sources: ["library", "twitter"] })] }),
      PARAMS,
    );
    expect(res.status).toBe(422);
  });

  it("422 when malformed JSON body", async () => {
    const req = new Request("http://test/api/jobs/job-1/search/multi/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    const res = await POST(req, PARAMS);
    expect(res.status).toBe(422);
  });
});

describe("POST /search/multi/import — LinkedIn-only path", () => {
  it("attaches a LinkedIn-only row as snippet-stage candidate", async () => {
    const res = await POST(
      makeReq({
        results: [row({ sources: ["linkedin"], candidateId: null })],
      }),
      PARAMS,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      outcomes: Array<{ status: string; resultId: string }>;
      counts: { attached: number; skipped: number; failed: number; total: number };
    };
    expect(body.counts).toEqual({ attached: 1, skipped: 0, failed: 0, total: 1 });
    expect(body.outcomes[0]).toMatchObject({ status: "attached", resultId: "row-1" });

    expect(dbMocks.prisma.candidate.upsert).toHaveBeenCalledTimes(1);
    const call = dbMocks.prisma.candidate.upsert.mock.calls[0][0];
    expect(call.create.source).toBe("scraper");
    expect(call.create.status).toBe("new");
    expect(call.create.profileText).toBe("Snippet text from SerpAPI");
    expect(call.create.headline).toBe("Engineer");
    expect(call.create.linkedinUrl).toMatch(/linkedin\.com\/in\/test-person/);
    expect(call.create.jobId).toBe("job-1");
    expect(call.create.orgId).toBe("org-A");
    // Re-import preserves existing data — update only re-tags source.
    expect(call.update).toEqual({ source: "scraper" });
  });

  it("attaches a PDL row with a LinkedIn URL and preserves PDL provenance", async () => {
    const res = await POST(
      makeReq({
        results: [row({ sources: ["pdl"], candidateId: null })],
      }),
      PARAMS,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      counts: { attached: number; skipped: number; failed: number; total: number };
    };
    expect(body.counts).toEqual({ attached: 1, skipped: 0, failed: 0, total: 1 });

    const call = dbMocks.prisma.candidate.upsert.mock.calls[0][0];
    expect(call.create.source).toBe("pdl");
    expect(call.update).toEqual({ source: "pdl" });
    expect(call.create.linkedinUrl).toMatch(/linkedin\.com\/in\/test-person/);
    expect(call.create.profileText).toBe("Snippet text from SerpAPI");
  });

  it("normalises the LinkedIn URL before upsert (idempotency)", async () => {
    await POST(
      makeReq({
        results: [
          row({
            id: "row-1",
            sources: ["linkedin"],
            // Trailing slash + mixed case + querystring — normaliser strips them.
            linkedinUrl: "https://www.LINKEDIN.com/in/Test-Person/?utm_source=foo",
          }),
        ],
      }),
      PARAMS,
    );
    const call = dbMocks.prisma.candidate.upsert.mock.calls[0][0];
    // Should be the normalised lowercase canonical form.
    expect(call.where.jobId_linkedinUrl.linkedinUrl).toBe(call.create.linkedinUrl);
    expect(call.create.linkedinUrl).not.toContain("utm_source");
  });

  it("falls back to 'Unknown' name when row.name is empty", async () => {
    await POST(
      makeReq({ results: [row({ name: "", sources: ["linkedin"] })] }),
      PARAMS,
    );
    const call = dbMocks.prisma.candidate.upsert.mock.calls[0][0];
    expect(call.create.name).toBe("Unknown");
  });

  it("skips LinkedIn-only row with no linkedinUrl", async () => {
    const res = await POST(
      makeReq({
        results: [row({ sources: ["linkedin"], linkedinUrl: null, candidateId: null })],
      }),
      PARAMS,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      outcomes: Array<{ status: string; reason?: string }>;
      counts: { skipped: number };
    };
    expect(body.counts.skipped).toBe(1);
    expect(body.outcomes[0]).toMatchObject({
      status: "skipped",
      reason: "no_usable_url_key",
    });
    expect(dbMocks.prisma.candidate.upsert).not.toHaveBeenCalled();
  });
});

describe("POST /search/multi/import — SEEK path", () => {
  it("attaches a live SEEK row (seekUrl, no candidateId, no linkedinUrl) as seek_scraper", async () => {
    const res = await POST(
      makeReq({
        results: [row({
          id: "seek-1",
          sources: ["seek"],
          candidateId: null,
          linkedinUrl: null,
          seekUrl: "https://nz.employer.seek.com/talentsearch/profile/12345/",
        })],
      }),
      PARAMS,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      counts: { attached: number; skipped: number; total: number };
      outcomes: Array<{ status: string }>;
    };
    expect(body.counts).toMatchObject({ attached: 1, skipped: 0, total: 1 });
    const call = dbMocks.prisma.candidate.upsert.mock.calls[0][0];
    // seekUrl is stored CANONICALISED via the shared normaliseSeekUrl (trailing
    // slash stripped, query/fragment removed) so dedup can't drift.
    expect(call.create.seekUrl).toBe("https://nz.employer.seek.com/talentsearch/profile/12345");
    expect(call.create.source).toBe("seek_scraper");
    // Synthetic (jobId, linkedinUrl) key — the normalised SEEK URL, NOT a real
    // http URL (so it never renders as a link) and consistent across re-imports.
    expect(String(call.create.linkedinUrl)).toBe("seek:https://nz.employer.seek.com/talentsearch/profile/12345");
    expect(call.where.jobId_linkedinUrl.linkedinUrl).toBe(call.create.linkedinUrl);
  });

  it("skips a SEEK row whose seekUrl is not a valid SEEK profile URL", async () => {
    const res = await POST(
      makeReq({ results: [row({ id: "bad", sources: ["seek"], candidateId: null, linkedinUrl: null, seekUrl: "https://example.com/not-seek" })] }),
      PARAMS,
    );
    const body = (await res.json()) as { counts: { attached: number; skipped: number }; outcomes: Array<{ reason?: string }> };
    expect(body.counts).toMatchObject({ attached: 0, skipped: 1 });
    expect(dbMocks.prisma.candidate.upsert).not.toHaveBeenCalled();
  });

  it("still skips a row with neither candidateId, linkedinUrl, nor seekUrl", async () => {
    const res = await POST(
      makeReq({ results: [row({ id: "bare", sources: ["seek"], candidateId: null, linkedinUrl: null, seekUrl: null })] }),
      PARAMS,
    );
    const body = (await res.json()) as { outcomes: Array<{ status: string; reason?: string }> };
    expect(body.outcomes[0]).toMatchObject({ status: "skipped", reason: "no_usable_url_key" });
    expect(dbMocks.prisma.candidate.upsert).not.toHaveBeenCalled();
  });
});

describe("POST /search/multi/import — Library path", () => {
  it("copies source candidate fields onto the new job-tied row", async () => {
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce({
      id: "src-1",
      name: "Source Name",
      headline: "Source Headline",
      location: "Source City",
      linkedinUrl: "https://www.linkedin.com/in/source",
      jobAdderUrl: "https://app.jobadder.com/candidates/123",
      profileText: "Full source profile text",
      profileCapturedAt: new Date("2025-01-01"),
      orgId: "org-A",
      job: null,
    });

    const res = await POST(
      makeReq({
        results: [
          row({
            id: "row-lib-1",
            sources: ["library"],
            candidateId: "src-1",
            candidateIdentityId: "ident-1",
          }),
        ],
      }),
      PARAMS,
    );
    expect(res.status).toBe(200);
    expect(dbMocks.prisma.candidate.findUnique).toHaveBeenCalledWith({
      where: { id: "src-1" },
      select: expect.any(Object),
    });

    const call = dbMocks.prisma.candidate.upsert.mock.calls[0][0];
    expect(call.create.name).toBe("Source Name");
    expect(call.create.headline).toBe("Source Headline");
    expect(call.create.location).toBe("Source City");
    expect(call.create.linkedinUrl).toBe("https://www.linkedin.com/in/source");
    expect(call.create.jobAdderUrl).toBe("https://app.jobadder.com/candidates/123");
    expect(call.create.profileText).toBe("Full source profile text");
    expect(call.create.source).toBe("talent_pool");
    expect(call.create.profileCapturedAt).toEqual(new Date("2025-01-01"));
  });

  it("uses synthetic library:<id> key when source has no linkedinUrl (JobAdder orphan)", async () => {
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce({
      id: "src-jobadder",
      name: "JobAdder Only",
      headline: null,
      location: null,
      linkedinUrl: null,
      jobAdderUrl: "https://app.jobadder.com/candidates/999",
      profileText: "CV text only",
      profileCapturedAt: null,
      orgId: "org-A",
      job: null,
    });

    await POST(
      makeReq({
        results: [
          row({
            id: "row-orphan",
            sources: ["library"],
            candidateId: "src-jobadder",
          }),
        ],
      }),
      PARAMS,
    );

    const call = dbMocks.prisma.candidate.upsert.mock.calls[0][0];
    expect(call.where.jobId_linkedinUrl).toEqual({
      jobId: "job-1",
      linkedinUrl: "library:src-jobadder",
    });
    expect(call.create.linkedinUrl).toBe("library:src-jobadder");
    expect(call.create.jobAdderUrl).toBe("https://app.jobadder.com/candidates/999");
  });

  it("skips library row when source candidate not found", async () => {
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce(null);
    const res = await POST(
      makeReq({
        results: [
          row({ sources: ["library"], candidateId: "missing-id" }),
        ],
      }),
      PARAMS,
    );
    const body = (await res.json()) as { outcomes: Array<{ status: string; reason?: string }> };
    expect(body.outcomes[0]).toMatchObject({
      status: "skipped",
      reason: "library_source_not_found",
    });
    expect(dbMocks.prisma.candidate.upsert).not.toHaveBeenCalled();
  });

  it("denies cross-org library import when source is in non-accessible org", async () => {
    orgAccessMocks.getAccessibleOrgIds.mockResolvedValueOnce(["org-A"]);
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce({
      id: "src-cross",
      name: "Cross Org Person",
      headline: null,
      location: null,
      linkedinUrl: "https://www.linkedin.com/in/cross",
      jobAdderUrl: "https://app.jobadder.com/candidates/000",
      profileText: "secret",
      profileCapturedAt: null,
      orgId: "org-B", // user has no access to org-B
      job: null,
    });

    const res = await POST(
      makeReq({
        results: [row({ sources: ["library"], candidateId: "src-cross" })],
      }),
      PARAMS,
    );
    const body = (await res.json()) as { outcomes: Array<{ status: string; reason?: string }> };
    expect(body.outcomes[0]).toMatchObject({
      status: "skipped",
      reason: "cross_org_no_access",
    });
    expect(dbMocks.prisma.candidate.upsert).not.toHaveBeenCalled();
  });

  it("strips jobAdderUrl on cross-org library import (when source is in a DIFFERENT accessible org)", async () => {
    // Cross-org but accessible — recruiter CAN see, but jobAdderUrl from another
    // org would let them open the other org's JobAdder record. Strip it.
    orgAccessMocks.getAccessibleOrgIds.mockResolvedValueOnce(["org-A", "org-B"]);
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce({
      id: "src-shared",
      name: "Shared Person",
      headline: null,
      location: null,
      linkedinUrl: "https://www.linkedin.com/in/shared",
      jobAdderUrl: "https://app.jobadder.com/candidates/orgB-only",
      profileText: "shared profile",
      profileCapturedAt: null,
      orgId: "org-B", // source is in org-B, job is in org-A
      job: null,
    });

    await POST(
      makeReq({
        results: [row({ sources: ["library"], candidateId: "src-shared" })],
      }),
      PARAMS,
    );
    const call = dbMocks.prisma.candidate.upsert.mock.calls[0][0];
    // jobAdderUrl from another org's ATS should be stripped.
    expect(call.create.jobAdderUrl).toBeNull();
    // Other fields still copied.
    expect(call.create.name).toBe("Shared Person");
    expect(call.create.profileText).toBe("shared profile");
  });

  it("PRESERVES jobAdderUrl on same-org library import", async () => {
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce({
      id: "src-same",
      name: "Same Org",
      headline: null,
      location: null,
      linkedinUrl: "https://www.linkedin.com/in/same",
      jobAdderUrl: "https://app.jobadder.com/candidates/123",
      profileText: "p",
      profileCapturedAt: null,
      orgId: "org-A", // same as job.orgId
      job: null,
    });
    await POST(
      makeReq({
        results: [row({ sources: ["library"], candidateId: "src-same" })],
      }),
      PARAMS,
    );
    const call = dbMocks.prisma.candidate.upsert.mock.calls[0][0];
    expect(call.create.jobAdderUrl).toBe("https://app.jobadder.com/candidates/123");
  });

  it("owner (accessibleOrgIds=null) can import any library row", async () => {
    orgAccessMocks.getAccessibleOrgIds.mockResolvedValueOnce(null);
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce({
      id: "src-any",
      name: "Any Org",
      headline: null,
      location: null,
      linkedinUrl: "https://www.linkedin.com/in/any",
      jobAdderUrl: "https://app.jobadder.com/candidates/any",
      profileText: "p",
      profileCapturedAt: null,
      orgId: "org-X",
      job: null,
    });

    const res = await POST(
      makeReq({
        results: [row({ sources: ["library"], candidateId: "src-any" })],
      }),
      PARAMS,
    );
    const body = (await res.json()) as { outcomes: Array<{ status: string }> };
    expect(body.outcomes[0].status).toBe("attached");
    const call = dbMocks.prisma.candidate.upsert.mock.calls[0][0];
    // Owner path: jobAdderUrl preserved (owner has full visibility across orgs).
    expect(call.create.jobAdderUrl).toBe("https://app.jobadder.com/candidates/any");
  });
});

describe("POST /search/multi/import — both-sources rows", () => {
  it("treats rows with sources=[library, linkedin] via the library path (library wins)", async () => {
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce({
      id: "src-both",
      name: "Library Wins Name",
      headline: "From Library",
      location: "Library Loc",
      linkedinUrl: "https://www.linkedin.com/in/both",
      jobAdderUrl: null,
      profileText: "library profile",
      profileCapturedAt: null,
      orgId: "org-A",
      job: null,
    });

    await POST(
      makeReq({
        results: [
          row({
            sources: ["library", "linkedin"],
            candidateId: "src-both",
            // These are LinkedIn-side values that should be IGNORED.
            name: "LinkedIn Name",
            headline: "LinkedIn Headline",
            snippet: "LinkedIn snippet",
          }),
        ],
      }),
      PARAMS,
    );
    const call = dbMocks.prisma.candidate.upsert.mock.calls[0][0];
    expect(call.create.name).toBe("Library Wins Name");
    expect(call.create.headline).toBe("From Library");
    expect(call.create.profileText).toBe("library profile");
  });
});

describe("POST /search/multi/import — outcomes + partial failure", () => {
  it("dedups rows with the same id within a batch", async () => {
    const res = await POST(
      makeReq({
        results: [
          row({ id: "dup", sources: ["linkedin"] }),
          row({ id: "dup", sources: ["linkedin"] }),
        ],
      }),
      PARAMS,
    );
    const body = (await res.json()) as { counts: { total: number; attached: number } };
    expect(body.counts.total).toBe(1);
    expect(body.counts.attached).toBe(1);
    expect(dbMocks.prisma.candidate.upsert).toHaveBeenCalledTimes(1);
  });

  it("one row throws, others continue: failed + attached counts both populated", async () => {
    // Reject by URL (not call order) so the assertion is deterministic even with
    // the concurrent worker pool — the "bad" row always fails, "good" succeeds.
    dbMocks.prisma.candidate.upsert.mockImplementation(
      async ({ create }: { create: Record<string, unknown> }) => {
        if (String(create.linkedinUrl).includes("/in/bad")) throw new Error("DB write error");
        return { id: "ok-1", ...create };
      },
    );

    const res = await POST(
      makeReq({
        results: [
          row({ id: "row-bad", sources: ["linkedin"], linkedinUrl: "https://www.linkedin.com/in/bad" }),
          row({ id: "row-good", sources: ["linkedin"], linkedinUrl: "https://www.linkedin.com/in/good" }),
        ],
      }),
      PARAMS,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      outcomes: Array<{ resultId: string; status: string; reason?: string }>;
      counts: { attached: number; failed: number; total: number };
    };
    expect(body.counts).toMatchObject({ attached: 1, failed: 1, total: 2 });
    expect(body.outcomes[0]).toMatchObject({
      resultId: "row-bad",
      status: "failed",
      reason: "DB write error",
    });
    expect(body.outcomes[1]).toMatchObject({ resultId: "row-good", status: "attached" });
  });

  it("returns counts shape with all four numeric fields even when mixed outcomes", async () => {
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce(null); // library miss → skip
    const res = await POST(
      makeReq({
        results: [
          row({ id: "ok", sources: ["linkedin"] }),
          row({ id: "skip-noss", sources: ["linkedin"], linkedinUrl: null }),
          row({ id: "skip-libmiss", sources: ["library"], candidateId: "missing" }),
        ],
      }),
      PARAMS,
    );
    const body = (await res.json()) as {
      counts: { attached: number; skipped: number; failed: number; total: number };
    };
    expect(body.counts).toEqual({ attached: 1, skipped: 2, failed: 0, total: 3 });
  });
});
