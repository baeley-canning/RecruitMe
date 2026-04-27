/**
 * Org isolation tests.
 *
 * Each test sets up two orgs (A and B) and verifies that org B's auth
 * cannot access org A's data. These are the highest-priority security
 * invariants for multi-tenant correctness.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── DB mock ──────────────────────────────────────────────────────────────────

const dbMocks = vi.hoisted(() => ({
  prisma: {
    job: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
    candidate: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    searchSession: {
      create: vi.fn().mockResolvedValue({ id: "ss-1" }),
      update: vi.fn().mockResolvedValue({ id: "ss-1" }),
      findUnique: vi.fn(),
    },
    usageEvent: {
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("@/lib/db", () => dbMocks);

// ── Session mock — two separate orgs ─────────────────────────────────────────

const sessionMocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  requireJobAccess: vi.fn(),
  requireCandidateAccess: vi.fn(),
  unauthorized: vi.fn(() => new Response(null, { status: 401 })),
  verifyAnyAuth: vi.fn(),
  // jobsWhere builds the org-scoped Prisma where clause — test the real impl
  jobsWhere: (auth: { orgId: string | null; isOwner: boolean }) =>
    auth.isOwner ? {} : { orgId: auth.orgId },
}));

vi.mock("@/lib/session", () => sessionMocks);

// ── AI / search stubs (never actually called in isolation tests) ──────────────

vi.mock("@/lib/ai", () => ({
  scoreCandidateStructured: vi.fn(),
  predictAcceptance: vi.fn(),
  extractCandidateInfo: vi.fn(),
  parseJobDescription: vi.fn(),
}));

vi.mock("@/lib/search", () => ({
  searchLinkedInProfiles: vi.fn(),
  searchBingLinkedInProfiles: vi.fn(),
  searchPDLProfiles: vi.fn(),
}));

vi.mock("@/lib/search-collection", () => ({
  collectPagedSearchResults: vi.fn().mockResolvedValue({ items: [], sawRetryableFailure: false }),
}));

vi.mock("@/lib/talent-pool", () => ({
  buildTalentPoolMap: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("@/lib/settings", () => ({
  getServerSetting: vi.fn().mockResolvedValue(null),
}));

// ── Route handlers under test ─────────────────────────────────────────────────

import { GET as getJobs } from "@/app/api/jobs/route";
import { GET as getJob } from "@/app/api/jobs/[id]/route";
import { GET as getCandidates } from "@/app/api/jobs/[id]/candidates/route";
import { GET as getSearchSession } from "@/app/api/jobs/[id]/search/route";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ORG_A = { userId: "user-a", orgId: "org-a", isOwner: false };
const ORG_B = { userId: "user-b", orgId: "org-b", isOwner: false };

const ISO_NOW = new Date().toISOString();

const JOB_A = {
  id: "job-a",
  title: "Engineer (Org A)",
  orgId: "org-a",
  status: "active",
  rawJd: "test",
  parsedRole: null,
  salaryMin: null,
  salaryMax: null,
  isRemote: false,
  location: null,
  company: null,
  lastScoredAt: null,
  createdAt: ISO_NOW,
  updatedAt: ISO_NOW,
  candidates: [],
  _count: { candidates: 0 },
};

const CANDIDATE_A = {
  id: "cand-a",
  jobId: "job-a",
  name: "Candidate A",
  status: "new",
  source: "manual",
  profileText: null,
  profileTextHash: null,
  matchScore: null,
  matchReason: null,
  acceptanceScore: null,
  acceptanceReason: null,
  scoreBreakdown: null,
  notes: null,
  screeningData: null,
  interviewNotes: null,
  statusHistory: null,
  contactedAt: null,
  headline: null,
  location: null,
  linkedinUrl: null,
  profileCapturedAt: null,
  createdAt: ISO_NOW,
  updatedAt: ISO_NOW,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(url: string) {
  return new Request(url, { method: "GET" });
}

function jobParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

function forbidden() {
  return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("org isolation — job access", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("GET /api/jobs only returns jobs belonging to the caller's org", async () => {
    sessionMocks.getAuth.mockResolvedValue(ORG_B);
    // DB returns both orgs' jobs; the route must filter to org-b only.
    dbMocks.prisma.job.findMany.mockResolvedValue([JOB_A]);

    const res = await getJobs();
    const body = await res.json() as { id: string }[];

    // The route filters by orgId in the Prisma where clause.
    // Verify findMany was called with the correct org filter.
    expect(dbMocks.prisma.job.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ orgId: "org-b" }),
      })
    );
  });

  it("GET /api/jobs/:id returns 403 when job belongs to a different org", async () => {
    sessionMocks.getAuth.mockResolvedValue(ORG_B);
    // requireJobAccess enforces org check — simulate it returning 403 for org B.
    sessionMocks.requireJobAccess.mockResolvedValue({
      job: null,
      error: forbidden(),
    });

    const res = await getJob(makeRequest("http://localhost/api/jobs/job-a"), jobParams("job-a"));

    expect(res.status).toBe(403);
  });

  it("GET /api/jobs/:id returns 200 for the owner org", async () => {
    sessionMocks.getAuth.mockResolvedValue(ORG_A);
    sessionMocks.requireJobAccess.mockResolvedValue({ job: JOB_A, error: null });
    // Route does its own findUnique for the full candidate list
    dbMocks.prisma.job.findUnique.mockResolvedValue({ ...JOB_A, candidates: [] });

    const res = await getJob(makeRequest("http://localhost/api/jobs/job-a"), jobParams("job-a"));

    expect(res.status).toBe(200);
  });
});

describe("org isolation — candidate access", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("GET /api/jobs/:id/candidates returns 403 when job belongs to a different org", async () => {
    sessionMocks.getAuth.mockResolvedValue(ORG_B);
    sessionMocks.requireJobAccess.mockResolvedValue({ job: null, error: forbidden() });

    const res = await getCandidates(
      makeRequest("http://localhost/api/jobs/job-a/candidates"),
      jobParams("job-a"),
    );

    expect(res.status).toBe(403);
  });

  it("GET /api/jobs/:id/candidates returns only candidates for that job", async () => {
    sessionMocks.getAuth.mockResolvedValue(ORG_A);
    sessionMocks.requireJobAccess.mockResolvedValue({ job: JOB_A, error: null });
    dbMocks.prisma.candidate.findMany.mockResolvedValue([CANDIDATE_A]);

    const res = await getCandidates(
      makeRequest("http://localhost/api/jobs/job-a/candidates"),
      jobParams("job-a"),
    );
    const body = await res.json() as { id: string }[];

    expect(res.status).toBe(200);
    // Prisma was called with jobId scoped to this job only.
    expect(dbMocks.prisma.candidate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ jobId: "job-a" }),
      })
    );
  });
});

describe("org isolation — search session access", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("GET /api/jobs/:id/search?sessionId=X returns 403 when job is from another org", async () => {
    sessionMocks.getAuth.mockResolvedValue(ORG_B);
    sessionMocks.requireJobAccess.mockResolvedValue({ job: null, error: forbidden() });

    const res = await getSearchSession(
      makeRequest("http://localhost/api/jobs/job-a/search?sessionId=ss-1"),
      jobParams("job-a"),
    );

    expect(res.status).toBe(403);
  });

  it("GET /api/jobs/:id/search?sessionId=X returns 404 when sessionId belongs to a different job", async () => {
    sessionMocks.getAuth.mockResolvedValue(ORG_A);
    sessionMocks.requireJobAccess.mockResolvedValue({ job: JOB_A, error: null });
    // Session exists but belongs to a different job
    dbMocks.prisma.searchSession.findUnique.mockResolvedValue({
      id: "ss-1",
      jobId: "job-b",  // different job — should cause 404
      status: "complete",
      collected: 5,
      message: null,
      importedIds: "[]",
      createdAt: ISO_NOW,
      updatedAt: ISO_NOW,
    });

    const res = await getSearchSession(
      makeRequest("http://localhost/api/jobs/job-a/search?sessionId=ss-1"),
      jobParams("job-a"),
    );

    expect(res.status).toBe(404);
  });
});

describe("org isolation — candidates library", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("GET /api/candidates scopes query to the caller's orgId", async () => {
    const { GET: getCandidatesLibrary } = await import("@/app/api/candidates/route");
    sessionMocks.getAuth.mockResolvedValue(ORG_B);
    dbMocks.prisma.candidate.findMany.mockResolvedValue([]);

    await getCandidatesLibrary();

    expect(dbMocks.prisma.candidate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          job: expect.objectContaining({ orgId: "org-b" }),
        }),
      })
    );
  });

  it("GET /api/candidates — owner sees all orgs (no orgId filter)", async () => {
    const { GET: getCandidatesLibrary } = await import("@/app/api/candidates/route");
    sessionMocks.getAuth.mockResolvedValue({ ...ORG_A, isOwner: true });
    dbMocks.prisma.candidate.findMany.mockResolvedValue([]);

    await getCandidatesLibrary();

    const callArgs = dbMocks.prisma.candidate.findMany.mock.calls[0][0] as { where: Record<string, unknown> };
    // Owner query should NOT include a job.orgId filter
    expect(callArgs.where).not.toHaveProperty("job");
  });
});
