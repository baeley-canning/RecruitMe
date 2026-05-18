import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    candidate: { findUnique: vi.fn() },
    contactEvent: { findMany: vi.fn(), create: vi.fn() },
    job: { findUnique: vi.fn(), findMany: vi.fn() },
    user: { findUnique: vi.fn().mockResolvedValue({ username: "alice" }) },
    orgAccessGrant: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

const sessionMocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  verifyAnyAuth: vi.fn(),
  unauthorized: vi.fn(() => new Response(null, { status: 401 })),
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/session", () => sessionMocks);

import { GET, POST } from "./route";
import { invalidateAccessCache } from "@/lib/org-access";

const ORG_VIEWER = { userId: "u-viewer", orgId: "org-viewer", isOwner: false };
const ORG_OWNER  = { userId: "u-owner",  orgId: "org-owner",  isOwner: true  };

function jsonRequest(body: unknown) {
  return new Request("http://localhost/api/candidates/cand-1/contacts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("contacts route — read/write access split", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateAccessCache("org-viewer");
    sessionMocks.getAuth.mockResolvedValue(ORG_VIEWER);
    sessionMocks.verifyAnyAuth.mockResolvedValue(ORG_VIEWER);
    dbMocks.prisma.contactEvent.findMany.mockResolvedValue([]);
    dbMocks.prisma.contactEvent.create.mockResolvedValue({
      id: "ev-1", type: "message", note: null, userName: "alice", userId: "u-viewer", jobId: null, createdAt: new Date(),
    });
  });

  it("GET 404s when candidate is in a partner org even with library_read grant", async () => {
    // Candidate belongs to org-A. Caller has library_read on org-A — but
    // GET should NOT consult that grant (reads expose other orgs' notes).
    dbMocks.prisma.candidate.findUnique.mockResolvedValue({ orgId: "org-A", job: null });
    dbMocks.prisma.orgAccessGrant.findMany.mockResolvedValue([
      { providerOrgId: "org-A", scope: "library_read" },
    ]);

    const res = await GET(new Request("http://localhost/api/candidates/cand-1/contacts"), {
      params: Promise.resolve({ id: "cand-1" }),
    });
    expect(res.status).toBe(404);
    expect(dbMocks.prisma.contactEvent.findMany).not.toHaveBeenCalled();
  });

  it("GET succeeds when candidate is in the caller's own org", async () => {
    dbMocks.prisma.candidate.findUnique.mockResolvedValue({ orgId: "org-viewer", job: null });
    const res = await GET(new Request("http://localhost/api/candidates/cand-1/contacts"), {
      params: Promise.resolve({ id: "cand-1" }),
    });
    expect(res.status).toBe(200);
    expect(dbMocks.prisma.contactEvent.findMany).toHaveBeenCalledTimes(1);
  });

  it("POST succeeds for a partner-org candidate with library_read grant", async () => {
    dbMocks.prisma.candidate.findUnique.mockResolvedValue({ orgId: "org-A", job: null });
    dbMocks.prisma.orgAccessGrant.findMany.mockResolvedValue([
      { providerOrgId: "org-A", scope: "library_read" },
    ]);
    const res = await POST(jsonRequest({ type: "message" }), { params: Promise.resolve({ id: "cand-1" }) });
    expect(res.status).toBe(201);
    // End-to-end shape: every field should be set, and orgId should be the
    // CALLER'S, not the candidate's — viewer's private record of "I messaged
    // this person", not partner-org history.
    const createArg = dbMocks.prisma.contactEvent.create.mock.calls[0][0].data;
    expect(createArg).toMatchObject({
      candidateId: "cand-1",
      orgId: "org-viewer",
      userId: "u-viewer",
      userName: "alice",
      type: "message",
      jobId: null,
    });
  });

  it("POST 404s for a partner-org candidate when the caller has NO grant", async () => {
    dbMocks.prisma.candidate.findUnique.mockResolvedValue({ orgId: "org-A", job: null });
    dbMocks.prisma.orgAccessGrant.findMany.mockResolvedValue([]);
    const res = await POST(jsonRequest({ type: "message" }), { params: Promise.resolve({ id: "cand-1" }) });
    expect(res.status).toBe(404);
    expect(dbMocks.prisma.contactEvent.create).not.toHaveBeenCalled();
  });

  it("Owner GET sees contact history for any org's candidate", async () => {
    sessionMocks.getAuth.mockResolvedValue(ORG_OWNER);
    dbMocks.prisma.candidate.findUnique.mockResolvedValue({ orgId: "org-A", job: null });
    const res = await GET(new Request("http://localhost/api/candidates/cand-1/contacts"), {
      params: Promise.resolve({ id: "cand-1" }),
    });
    expect(res.status).toBe(200);
  });
});
