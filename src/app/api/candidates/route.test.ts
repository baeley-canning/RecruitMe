import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    candidate: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    org: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    orgAccessGrant: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

const sessionMocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  unauthorized: vi.fn(() => new Response(null, { status: 401 })),
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/session", () => sessionMocks);

import { GET, POST } from "./route";

describe("candidates library API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionMocks.getAuth.mockResolvedValue({ userId: "user-1", orgId: "org-1", isOwner: false });
  });

  it("returns every row that passes the SQL where-clause, dedupes by LinkedIn URL, and omits profileText", async () => {
    // profileText is no longer SELECTed (see route.ts comment) — pulling
    // it inflated SSR memory by hundreds of MB. The JS-side length gate
    // (hasFullCandidateProfile) was removed as a side-effect; the SQL
    // where-clause already enforces source-whitelist or profileText present.
    const now = new Date();
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      {
        id: "short-1",
        name: "Snippet Person",
        headline: "Developer",
        location: "Wellington",
        linkedinUrl: "https://www.linkedin.com/in/snippet/",
        matchScore: 61,
        source: "serpapi",
        status: "new",
        profileCapturedAt: null,
        createdAt: now,
        jobId: "job-1",
        job: { id: "job-1", title: "Developer", company: "Acme" },
        files: [],
      },
      {
        id: "full-1",
        name: "Full Person",
        headline: "Developer",
        location: "Wellington",
        linkedinUrl: "https://www.linkedin.com/in/full/",
        matchScore: 80,
        source: "extension",
        status: "new",
        profileCapturedAt: null,
        createdAt: now,
        jobId: "job-1",
        job: { id: "job-1", title: "Developer", company: "Acme" },
        files: [],
      },
      {
        id: "captured-short",
        name: "Captured Person",
        headline: "Designer",
        location: "Wellington",
        linkedinUrl: "https://www.linkedin.com/in/captured/",
        matchScore: 72,
        source: "extension",
        status: "new",
        profileCapturedAt: now,
        createdAt: now,
        jobId: "job-2",
        job: { id: "job-2", title: "Designer", company: "Beta" },
        files: [],
      },
    ]);

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    // All three pass the SQL filter (mock); LinkedIn URLs are distinct so
    // no dedupe collisions. profileText is NOT present in any row.
    expect(body.map((row: { id: string }) => row.id).sort()).toEqual(
      ["captured-short", "full-1", "short-1"],
    );
    body.forEach((row: Record<string, unknown>) => {
      expect(row).not.toHaveProperty("profileText");
    });
  });

  it("normalizes LinkedIn URLs when creating library candidates", async () => {
    dbMocks.prisma.candidate.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "library-1",
      ...data,
    }));

    const res = await POST(new Request("http://localhost/api/candidates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Ranjana Tyagi",
        linkedinUrl: "https://nz.linkedin.com/in/ranjana-tyagi-3755b615/?trk=people",
      }),
    }));

    expect(res.status).toBe(201);
    expect(dbMocks.prisma.candidate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          linkedinUrl: "https://www.linkedin.com/in/ranjana-tyagi-3755b615",
        }),
      })
    );
  });
});
