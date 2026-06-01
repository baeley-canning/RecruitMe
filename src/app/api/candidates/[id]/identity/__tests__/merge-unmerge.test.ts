/**
 * Integration tests for PR 5 — identity merge + unmerge routes.
 *
 * Pins the safety invariants the design depends on:
 *  • Cross-org merges are refused (Critic A §10 + plan §A.5)
 *  • Tombstones block re-merge of a previously-unmerged pair (Critic A §1.4)
 *  • Unmerge writes a tombstone with isTombstone=true
 *  • Unmerge refuses when there's no prior merge of the pair
 *  • Both routes 404 when the feature flag is off
 *
 * All DB interaction mocked through @/lib/db. No real Prisma.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => {
  const candidate = {
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  };
  const candidateIdentity = {
    findUnique: vi.fn(),
    update: vi.fn(),
  };
  const candidateIdentityMerge = {
    create: vi.fn(),
    upsert: vi.fn(),
    findFirst: vi.fn(),
  };
  const prisma = {
    candidate,
    candidateIdentity,
    candidateIdentityMerge,
    $transaction: vi.fn(async (cb: (tx: typeof prisma) => unknown) => cb(prisma)),
  };
  return { prisma };
});

const sessionMocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  unauthorized: vi.fn(() => new Response(null, { status: 401 })),
}));

// Feature flag is read at module import time inside the route handlers,
// so we need to set the env var BEFORE importing them. vi.hoisted runs
// before module imports — set there.
vi.hoisted(() => {
  process.env.RECRUITME_IDENTITY_MERGE_UI_ENABLED = "true";
});

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/session", () => sessionMocks);

import { POST as mergePOST } from "@/app/api/candidates/[id]/identity/merge/route";
import { POST as unmergePOST } from "@/app/api/candidates/[id]/identity/unmerge/route";

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.prisma.candidate.findUnique.mockReset();
  dbMocks.prisma.candidate.update.mockReset();
  dbMocks.prisma.candidate.updateMany.mockReset();
  dbMocks.prisma.candidateIdentity.findUnique.mockReset();
  dbMocks.prisma.candidateIdentity.update.mockReset();
  dbMocks.prisma.candidateIdentityMerge.create.mockReset();
  dbMocks.prisma.candidateIdentityMerge.findFirst.mockReset();
  sessionMocks.getAuth.mockResolvedValue({ userId: "u1", orgId: "org-A", isOwner: false });
});

function makeReq(body: unknown): Request {
  return new Request("http://test/api/candidates/cand-1/identity/merge", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ────────────────────────────────────────────────────────────────────────
// merge route
// ────────────────────────────────────────────────────────────────────────

describe("POST /identity/merge — happy path", () => {
  it("writes audit row, sets mergedIntoIdentityId, re-points candidates", async () => {
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce({
      id: "cand-1", orgId: "org-A", candidateIdentityId: "ident-src",
    });
    dbMocks.prisma.candidateIdentity.findUnique
      .mockResolvedValueOnce({ id: "ident-src", orgId: "org-A", mergedIntoIdentityId: null })
      .mockResolvedValueOnce({ id: "ident-survivor", orgId: "org-A", mergedIntoIdentityId: null });
    dbMocks.prisma.candidateIdentityMerge.findFirst.mockResolvedValueOnce(null); // no tombstone
    dbMocks.prisma.candidate.updateMany.mockResolvedValueOnce({ count: 2 });

    const req = makeReq({ survivorIdentityId: "ident-survivor" });
    const res = await mergePOST(req, { params: Promise.resolve({ id: "cand-1" }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.merged).toBe(true);
    expect(body.candidatesMoved).toBe(2);

    // Audit row written with reason=recruiter_confirm, isTombstone=false.
    const createCall = dbMocks.prisma.candidateIdentityMerge.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(createCall.data.reason).toBe("recruiter_confirm");
    expect(createCall.data.isTombstone).toBe(false);
    expect(createCall.data.orgId).toBe("org-A");

    // Source identity points to survivor.
    expect(dbMocks.prisma.candidateIdentity.update).toHaveBeenCalledWith({
      where: { id: "ident-src" },
      data: { mergedIntoIdentityId: "ident-survivor" },
    });

    // All in-org candidates moved.
    expect(dbMocks.prisma.candidate.updateMany).toHaveBeenCalledWith({
      where: { candidateIdentityId: "ident-src", orgId: "org-A" },
      data: { candidateIdentityId: "ident-survivor" },
    });
  });
});

describe("POST /identity/merge — refusals", () => {
  it("refuses cross-org merge (Critic A §10 + plan §A.5)", async () => {
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce({
      id: "cand-1", orgId: "org-A", candidateIdentityId: "ident-src",
    });
    dbMocks.prisma.candidateIdentity.findUnique
      .mockResolvedValueOnce({ id: "ident-src", orgId: "org-A", mergedIntoIdentityId: null })
      .mockResolvedValueOnce({ id: "ident-survivor", orgId: "org-B", mergedIntoIdentityId: null });

    const req = makeReq({ survivorIdentityId: "ident-survivor" });
    const res = await mergePOST(req, { params: Promise.resolve({ id: "cand-1" }) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body.error as string).toLowerCase()).toContain("cross-org");
    expect(dbMocks.prisma.candidateIdentityMerge.create).not.toHaveBeenCalled();
  });

  it("refuses when a tombstone exists for the pair (Critic A §1.4)", async () => {
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce({
      id: "cand-1", orgId: "org-A", candidateIdentityId: "ident-src",
    });
    dbMocks.prisma.candidateIdentity.findUnique
      .mockResolvedValueOnce({ id: "ident-src", orgId: "org-A", mergedIntoIdentityId: null })
      .mockResolvedValueOnce({ id: "ident-survivor", orgId: "org-A", mergedIntoIdentityId: null });
    dbMocks.prisma.candidateIdentityMerge.findFirst.mockResolvedValueOnce({
      id: "tombstone-1",
      mergedAt: new Date(),
    });

    const req = makeReq({ survivorIdentityId: "ident-survivor" });
    const res = await mergePOST(req, { params: Promise.resolve({ id: "cand-1" }) });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body.error as string).toLowerCase()).toContain("unmerged");
    expect(body.tombstoneCreatedAt).toBeTruthy();
    expect(dbMocks.prisma.candidateIdentityMerge.create).not.toHaveBeenCalled();
  });

  it("refuses when the candidate has no identity yet", async () => {
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce({
      id: "cand-1", orgId: "org-A", candidateIdentityId: null,
    });

    const req = makeReq({ survivorIdentityId: "ident-survivor" });
    const res = await mergePOST(req, { params: Promise.resolve({ id: "cand-1" }) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body.error as string).toLowerCase()).toContain("clustering");
  });

  it("refuses when source and survivor identities are the same", async () => {
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce({
      id: "cand-1", orgId: "org-A", candidateIdentityId: "ident-same",
    });
    const req = makeReq({ survivorIdentityId: "ident-same" });
    const res = await mergePOST(req, { params: Promise.resolve({ id: "cand-1" }) });
    expect(res.status).toBe(400);
  });

  it("refuses when the candidate belongs to another org and caller is not owner", async () => {
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce({
      id: "cand-1", orgId: "org-OTHER", candidateIdentityId: "ident-src",
    });
    const req = makeReq({ survivorIdentityId: "ident-survivor" });
    const res = await mergePOST(req, { params: Promise.resolve({ id: "cand-1" }) });
    expect(res.status).toBe(403);
  });

  it("returns 404 when the feature flag is OFF", async () => {
    process.env.RECRUITME_IDENTITY_MERGE_UI_ENABLED = "false";
    const req = makeReq({ survivorIdentityId: "ident-survivor" });
    const res = await mergePOST(req, { params: Promise.resolve({ id: "cand-1" }) });
    expect(res.status).toBe(404);
    process.env.RECRUITME_IDENTITY_MERGE_UI_ENABLED = "true";
  });

  it("422s on body validation failure", async () => {
    const req = new Request("http://test/api/candidates/cand-1/identity/merge", {
      method: "POST",
      body: "{}",
    });
    const res = await mergePOST(req, { params: Promise.resolve({ id: "cand-1" }) });
    expect(res.status).toBe(422);
  });
});

// ────────────────────────────────────────────────────────────────────────
// unmerge route
// ────────────────────────────────────────────────────────────────────────

describe("POST /identity/unmerge — happy path", () => {
  it("writes a TOMBSTONE row and re-points the candidate at the original identity", async () => {
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce({
      id: "cand-1", orgId: "org-A", candidateIdentityId: "ident-survivor",
    });
    dbMocks.prisma.candidateIdentity.findUnique
      .mockResolvedValueOnce({ id: "ident-original", orgId: "org-A", mergedIntoIdentityId: "ident-survivor" })
      .mockResolvedValueOnce({ id: "ident-survivor", orgId: "org-A" });
    dbMocks.prisma.candidateIdentityMerge.findFirst.mockResolvedValueOnce({ id: "merge-row-1" });

    const req = new Request("http://test/api/candidates/cand-1/identity/unmerge", {
      method: "POST",
      body: JSON.stringify({ originalIdentityId: "ident-original" }),
    });
    const res = await unmergePOST(req, { params: Promise.resolve({ id: "cand-1" }) });
    expect(res.status).toBe(200);

    // Tombstone written via idempotent upsert (not create-and-catch-P2002,
    // which would poison the transaction on a real conflict).
    const upsertCall = dbMocks.prisma.candidateIdentityMerge.upsert.mock.calls[0][0] as {
      create: Record<string, unknown>;
      where: Record<string, unknown>;
    };
    expect(upsertCall.create.isTombstone).toBe(true);
    expect(upsertCall.create.reason).toBe("unmerge");

    // Original identity detached.
    expect(dbMocks.prisma.candidateIdentity.update).toHaveBeenCalledWith({
      where: { id: "ident-original" },
      data: { mergedIntoIdentityId: null },
    });

    // Candidate re-pointed.
    expect(dbMocks.prisma.candidate.update).toHaveBeenCalledWith({
      where: { id: "cand-1" },
      data: { candidateIdentityId: "ident-original" },
    });
  });

  it("idempotent when the tombstone already exists — upsert no-ops, tx still completes", async () => {
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce({
      id: "cand-1", orgId: "org-A", candidateIdentityId: "ident-survivor",
    });
    dbMocks.prisma.candidateIdentity.findUnique
      .mockResolvedValueOnce({ id: "ident-original", orgId: "org-A", mergedIntoIdentityId: null })
      .mockResolvedValueOnce({ id: "ident-survivor", orgId: "org-A" });
    dbMocks.prisma.candidateIdentityMerge.findFirst.mockResolvedValueOnce({ id: "merge-row-1" });
    // upsert is the idempotency mechanism now — it resolves (update:{}) when the
    // tombstone exists rather than throwing a P2002 that would poison the tx.
    dbMocks.prisma.candidateIdentityMerge.upsert.mockResolvedValueOnce({});

    const req = new Request("http://test/api/candidates/cand-1/identity/unmerge", {
      method: "POST",
      body: JSON.stringify({ originalIdentityId: "ident-original" }),
    });
    const res = await unmergePOST(req, { params: Promise.resolve({ id: "cand-1" }) });
    expect(res.status).toBe(200);
    // The rest of the transaction proceeds (this is what the old create-and-
    // catch-P2002 broke: a conflict aborted the tx and the candidate was never
    // re-pointed).
    expect(dbMocks.prisma.candidate.update).toHaveBeenCalled();
  });
});

describe("POST /identity/unmerge — refusals", () => {
  it("refuses when there's no prior merge of the pair", async () => {
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce({
      id: "cand-1", orgId: "org-A", candidateIdentityId: "ident-survivor",
    });
    dbMocks.prisma.candidateIdentity.findUnique
      .mockResolvedValueOnce({ id: "ident-original", orgId: "org-A", mergedIntoIdentityId: null })
      .mockResolvedValueOnce({ id: "ident-survivor", orgId: "org-A" });
    dbMocks.prisma.candidateIdentityMerge.findFirst.mockResolvedValueOnce(null);

    const req = new Request("http://test/api/candidates/cand-1/identity/unmerge", {
      method: "POST",
      body: JSON.stringify({ originalIdentityId: "ident-original" }),
    });
    const res = await unmergePOST(req, { params: Promise.resolve({ id: "cand-1" }) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body.error as string).toLowerCase()).toContain("no prior merge");
  });

  it("refuses cross-org unmerge", async () => {
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce({
      id: "cand-1", orgId: "org-A", candidateIdentityId: "ident-survivor",
    });
    dbMocks.prisma.candidateIdentity.findUnique
      .mockResolvedValueOnce({ id: "ident-original", orgId: "org-A", mergedIntoIdentityId: null })
      .mockResolvedValueOnce({ id: "ident-survivor", orgId: "org-B" });

    const req = new Request("http://test/api/candidates/cand-1/identity/unmerge", {
      method: "POST",
      body: JSON.stringify({ originalIdentityId: "ident-original" }),
    });
    const res = await unmergePOST(req, { params: Promise.resolve({ id: "cand-1" }) });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the feature flag is OFF", async () => {
    process.env.RECRUITME_IDENTITY_MERGE_UI_ENABLED = "false";
    const req = new Request("http://test/api/candidates/cand-1/identity/unmerge", {
      method: "POST",
      body: JSON.stringify({ originalIdentityId: "ident-original" }),
    });
    const res = await unmergePOST(req, { params: Promise.resolve({ id: "cand-1" }) });
    expect(res.status).toBe(404);
    process.env.RECRUITME_IDENTITY_MERGE_UI_ENABLED = "true";
  });
});
