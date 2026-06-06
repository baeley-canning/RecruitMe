import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  prisma: { candidate: { findMany: vi.fn() } },
}));
const queueMocks = vi.hoisted(() => ({ enqueueScrapeJob: vi.fn() }));
const sessionMocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  requireJobAccess: vi.fn(),
  unauthorized: vi.fn(() => new Response("unauth", { status: 401 })),
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/scrape-queue", () => queueMocks);
vi.mock("@/lib/session", () => sessionMocks);

import { POST, GET } from "./route";

const params = (id = "job-1") => ({ params: Promise.resolve({ id }) });

function postReq(body: unknown) {
  return new Request("http://localhost/api/jobs/job-1/candidates/bulk-capture", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("bulk-capture POST", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionMocks.getAuth.mockResolvedValue({ userId: "u1", orgId: "org-1" });
    sessionMocks.requireJobAccess.mockResolvedValue({ job: { id: "job-1", orgId: "org-1" }, error: null });
    queueMocks.enqueueScrapeJob.mockResolvedValue({ id: "scrape-1" });
  });

  it("enqueues a LinkedIn fetch for a thin candidate; skips full profiles + SEEK-only", async () => {
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      { id: "thin-li", profileText: "", linkedinUrl: "https://linkedin.com/in/x", jobAdderUrl: null },
      { id: "full",    profileText: "x".repeat(500), linkedinUrl: "https://linkedin.com/in/y", jobAdderUrl: null },
      { id: "seek",    profileText: "", linkedinUrl: null, jobAdderUrl: null }, // SEEK-only → no capturable URL
    ]);
    const res = await POST(postReq({ ids: ["thin-li", "full", "seek"] }), params());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(queueMocks.enqueueScrapeJob).toHaveBeenCalledTimes(1);
    expect(queueMocks.enqueueScrapeJob).toHaveBeenCalledWith(expect.objectContaining({
      platform: "linkedin", profileUrl: "https://linkedin.com/in/x", candidateId: "thin-li", orgId: "org-1",
    }));
    expect(body).toMatchObject({ enqueued: 1, alreadyFull: 1, noCapturableUrl: 1 });
  });

  it("counts a dedup hit (already queued) without enqueuing twice", async () => {
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      { id: "thin-li", profileText: "", linkedinUrl: "https://linkedin.com/in/x", jobAdderUrl: null },
    ]);
    queueMocks.enqueueScrapeJob.mockResolvedValue(null); // dedup → already pending/processing
    const res = await POST(postReq({ ids: ["thin-li"] }), params());
    expect(await res.json()).toMatchObject({ enqueued: 0, alreadyQueued: 1 });
  });

  it("prefers JobAdder when there's no LinkedIn URL", async () => {
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      { id: "ja", profileText: null, linkedinUrl: null, jobAdderUrl: "https://ja.example/c/1" },
    ]);
    await POST(postReq({ ids: ["ja"] }), params());
    expect(queueMocks.enqueueScrapeJob).toHaveBeenCalledWith(expect.objectContaining({ platform: "jobadder" }));
  });

  it("422 on empty ids", async () => {
    expect((await POST(postReq({ ids: [] }), params())).status).toBe(422);
  });
});

describe("bulk-capture GET (progress)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionMocks.getAuth.mockResolvedValue({ userId: "u1", orgId: "org-1" });
    sessionMocks.requireJobAccess.mockResolvedValue({ job: { id: "job-1", orgId: "org-1" }, error: null });
  });

  it("reports captured vs pending by full-profile presence", async () => {
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      { profileText: "x".repeat(500) }, // captured
      { profileText: "" },              // pending
      { profileText: null },            // pending
    ]);
    const req = new Request("http://localhost/api/jobs/job-1/candidates/bulk-capture?ids=a,b,c");
    const res = await GET(req, params());
    expect(await res.json()).toMatchObject({ total: 3, captured: 1, pending: 2 });
  });
});
