import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    candidate: {
      findMany: vi.fn(),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
    },
    org: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    orgAccessGrant: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    // $queryRaw is the length-gate pre-filter introduced for the "Bede
    // problem" — returns the IDs of library rows with profileText >= 500
    // chars. Tests that don't care about filtering just echo back every
    // ID from the findMany mock so the existing assertions still see them.
    $queryRaw: vi.fn(),
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
    // The new $queryRaw pre-filter (Bede fix) echoes the IDs we expect to
    // pass the 500-char gate — for this test, all three.
    dbMocks.prisma.$queryRaw.mockResolvedValueOnce([
      { id: "short-1" }, { id: "full-1" }, { id: "captured-short" },
    ]);
    const now = new Date();
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      {
        id: "short-1",
        name: "Snippet Person",
        headline: "Developer",
        location: "Wellington",
        linkedinUrl: "https://www.linkedin.com/in/snippet/",
        matchScore: 61,
        source: "scraper",
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

    const res = await GET(new Request("http://localhost/api/candidates"));
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

  it("expands cross-org grants in the SQL WHERE clause and attaches sharedFromOrgName", async () => {
    // The user is in org-viewer with a library_read grant on org-provider.
    // Pre-refactor, the page-level SSR bug was: only the viewer's own org
    // candidates surfaced because the WHERE clause used auth.orgId raw
    // instead of expanding via getAccessibleOrgIds. This test pins the fix.
    //
    // Using a fresh orgId so we don't hit the module-level
    // getAccessibleOrgIds cache from earlier tests in this file.
    sessionMocks.getAuth.mockResolvedValue({ userId: "user-1", orgId: "org-viewer", isOwner: false });
    dbMocks.prisma.orgAccessGrant.findMany.mockResolvedValueOnce([
      { providerOrgId: "org-provider", scope: "library_read" },
    ]);
    dbMocks.prisma.org.findMany.mockResolvedValueOnce([
      { id: "org-provider", name: "Provider Inc" },
    ]);
    // $queryRaw pre-filter returns both IDs — they both pass the 500-char gate.
    dbMocks.prisma.$queryRaw.mockResolvedValueOnce([{ id: "own-1" }, { id: "shared-1" }]);
    const now = new Date();
    dbMocks.prisma.candidate.findMany.mockResolvedValueOnce([
      {
        id: "own-1",
        name: "Local Person",
        headline: "Engineer",
        location: "Wellington",
        linkedinUrl: "https://www.linkedin.com/in/local/",
        matchScore: 80,
        source: "extension",
        status: "new",
        notes: null,
        profileCapturedAt: now,
        createdAt: now,
        jobId: "job-own",
        orgId: "org-viewer",
        archivedJobTitle: null,
        archivedJobCompany: null,
        job: { id: "job-own", title: "Engineer", company: "OurCo", orgId: "org-viewer" },
        files: [],
      },
      {
        id: "shared-1",
        name: "Shared Person",
        headline: "Engineer",
        location: "Auckland",
        linkedinUrl: "https://www.linkedin.com/in/shared/",
        matchScore: 75,
        source: "extension",
        status: "new",
        notes: null,
        profileCapturedAt: now,
        createdAt: now,
        jobId: "job-shared",
        orgId: "org-provider",
        archivedJobTitle: null,
        archivedJobCompany: null,
        job: { id: "job-shared", title: "Engineer", company: "TheirCo", orgId: "org-provider" },
        files: [],
      },
    ]);

    const res = await GET(new Request("http://localhost/api/candidates"));
    const body = await res.json();

    expect(res.status).toBe(200);
    // Helper expanded WHERE to include both the viewer's own org and the granted provider.
    const whereArg = dbMocks.prisma.candidate.findMany.mock.calls[0][0].where;
    expect(JSON.stringify(whereArg)).toContain("org-provider");
    expect(JSON.stringify(whereArg)).toContain("org-viewer");

    const byId = Object.fromEntries(body.map((row: { id: string }) => [row.id, row]));
    expect(byId["own-1"].sharedFromOrgName).toBeNull();              // same org → no badge
    expect(byId["shared-1"].sharedFromOrgName).toBe("Provider Inc"); // cross-org → badge
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
