/**
 * Route-level tests for /api/candidates/[id]/photo.
 *
 * Same vi.hoisted + vi.mock pattern as the surrounding /files route and the
 * cv-preview-route tests, so the mock plumbing reads consistently.
 *
 * What the tests pin (and why):
 *  • POST happy path writes one CandidateFile + updates Candidate.photoFileId
 *    in a single $transaction. Atomicity is load-bearing — without the tx
 *    a crash between create + update would leave an encrypted-blob orphan.
 *  • Non-image MIMEs are rejected with 415 before any DB write.
 *  • Files over 5MB are rejected with 413 (smaller cap than CV upload's 10MB
 *    so a recruiter can't smuggle a 9MB photo through the photo route).
 *  • POST with an existing photoFileId deletes the previous CandidateFile
 *    row inside the same transaction. Otherwise photos accumulate per
 *    candidate as recruiters iterate, wasting encrypted storage.
 *  • DELETE clears Candidate.photoFileId and removes the CandidateFile row.
 *  • DELETE on a candidate with no photo returns 404 so the UI can show
 *    "nothing to remove" without retrying.
 *  • Cross-org viewers get 404 on both verbs — never reveal existence.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    candidate: {
      findUnique: vi.fn(),
    },
    candidateFile: {
      // The route reads the previous/target photo row's storageKey (outside the
      // transaction) so it can drop the backing blob from the object store after
      // a swap/delete commits. Default undefined → no blob cleanup (inline rows).
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

const sessionMocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  unauthorized: vi.fn(() => new Response(null, { status: 401 })),
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/session", () => sessionMocks);
vi.mock("@/lib/cv-encryption", () => ({
  // Passthrough — encryption is unit-tested in cv-encryption.test.ts. Here we
  // want to check the route's transaction shape, not crypto correctness.
  encryptCv: vi.fn(async (plain: string) => `v1:enc(${plain.slice(0, 12)})`),
}));
vi.mock("@/lib/error-reporting", () => ({
  reportError: vi.fn(),
}));

import { POST, DELETE } from "./route";

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

type DuckFile = { name: string; type: string; size: number; arrayBuffer: () => Promise<ArrayBuffer> };

function makePngFile(name = "headshot.png", bytes = 1024): DuckFile {
  // A File-like duck. The route uses arrayBuffer() + name/type/size, not the
  // class identity, so we don't depend on a global File constructor.
  return {
    name,
    type: "image/png",
    size: bytes,
    arrayBuffer: async () => new Uint8Array(bytes).buffer,
  };
}

/**
 * Stand in for `FormData` so we can hand the route a `formData()` shim that
 * returns our duck-typed file. jsdom's FormData rejects non-Blob values via
 * `append`, and we deliberately avoid constructing a real `File` so the
 * Node-runtime "File is not defined" handling stays load-bearing in the
 * production code path. The route only calls `formData.get("file")` so a
 * tiny shim is enough.
 */
function makeFormShim(file: DuckFile | null) {
  return {
    get: (key: string) => (key === "file" ? file : null),
  } as unknown as FormData;
}

async function callPost(file: DuckFile | null) {
  // Custom Request subclass so we can stub `formData()` directly instead of
  // round-tripping through multipart encode/decode. The route's only contract
  // with the request body is `await req.formData()`.
  const req = new Request("http://localhost/api/candidates/cand-1/photo", { method: "POST" });
  Object.defineProperty(req, "formData", { value: async () => makeFormShim(file) });
  return POST(req, { params: Promise.resolve({ id: "cand-1" }) });
}

async function callDelete() {
  const req = new Request("http://localhost/api/candidates/cand-1/photo", {
    method: "DELETE",
  });
  return DELETE(req, { params: Promise.resolve({ id: "cand-1" }) });
}

function mockCandidate(overrides: Partial<{ orgId: string; photoFileId: string | null; jobOrgId: string | null }> = {}) {
  return {
    id: "cand-1",
    orgId: overrides.orgId ?? "org-1",
    photoFileId: overrides.photoFileId ?? null,
    job: overrides.jobOrgId === undefined ? null : { orgId: overrides.jobOrgId },
  };
}

beforeEach(() => {
  // `resetAllMocks` (not `clearAllMocks`) so previous tests' `mockResolvedValueOnce`
  // queues + `mockImplementationOnce` chains don't bleed across tests. Without
  // this the "no photo" DELETE test would re-consume a leftover `null` from the
  // POST suite's auth-failure setup.
  vi.resetAllMocks();
  sessionMocks.getAuth.mockResolvedValue({ userId: "u1", orgId: "org-1", isOwner: false });
  sessionMocks.unauthorized.mockImplementation(() => new Response(null, { status: 401 }));
});

// ────────────────────────────────────────────────────────────────────────────
// POST
// ────────────────────────────────────────────────────────────────────────────

describe("POST /api/candidates/[id]/photo", () => {
  it("rejects requests with no file with 400", async () => {
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce(mockCandidate());
    const res = await callPost(null);
    expect(res.status).toBe(400);
    expect(dbMocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects non-image MIME types with 415", async () => {
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce(mockCandidate());
    const pdfFile = { ...makePngFile("evil.pdf"), type: "application/pdf" };
    const res = await callPost(pdfFile);
    expect(res.status).toBe(415);
    expect(dbMocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects files over 5MB with 413", async () => {
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce(mockCandidate());
    const huge = makePngFile("huge.png", 6 * 1024 * 1024);
    const res = await callPost(huge);
    expect(res.status).toBe(413);
    expect(dbMocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("creates a new CandidateFile and sets photoFileId atomically", async () => {
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce(mockCandidate());

    const tx = {
      candidateFile: {
        create: vi.fn().mockResolvedValue({ id: "new-photo-file-1" }),
        delete: vi.fn().mockResolvedValue({}),
      },
      candidate: {
        update: vi.fn().mockResolvedValue({}),
      },
    };
    dbMocks.prisma.$transaction.mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx));

    const res = await callPost(makePngFile());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.photoFileId).toBe("new-photo-file-1");
    expect(body.photoUrl).toBe("/api/candidates/cand-1/files/new-photo-file-1?inline=1");

    expect(tx.candidateFile.create).toHaveBeenCalledTimes(1);
    expect(tx.candidate.update).toHaveBeenCalledWith({
      where: { id: "cand-1" },
      data: { photoFileId: "new-photo-file-1" },
    });
    // No prior photo → no delete call.
    expect(tx.candidateFile.delete).not.toHaveBeenCalled();
  });

  it("deletes the previous CandidateFile inside the same transaction when replacing", async () => {
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce(
      mockCandidate({ photoFileId: "old-photo-file" }),
    );

    const tx = {
      candidateFile: {
        create: vi.fn().mockResolvedValue({ id: "new-photo-file-2" }),
        delete: vi.fn().mockResolvedValue({}),
      },
      candidate: {
        update: vi.fn().mockResolvedValue({}),
      },
    };
    dbMocks.prisma.$transaction.mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx));

    const res = await callPost(makePngFile());
    expect(res.status).toBe(201);

    expect(tx.candidateFile.delete).toHaveBeenCalledWith({ where: { id: "old-photo-file" } });
    expect(tx.candidate.update).toHaveBeenCalledWith({
      where: { id: "cand-1" },
      data: { photoFileId: "new-photo-file-2" },
    });
  });

  it("returns 404 when the candidate doesn't exist", async () => {
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce(null);
    const res = await callPost(makePngFile());
    expect(res.status).toBe(404);
    expect(dbMocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("cross-org viewer gets 404 — never reveal existence", async () => {
    sessionMocks.getAuth.mockResolvedValueOnce({ userId: "u2", orgId: "org-OTHER", isOwner: false });
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce(mockCandidate({ orgId: "org-1" }));
    const res = await callPost(makePngFile());
    expect(res.status).toBe(404);
    expect(dbMocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("returns 401 when not authenticated", async () => {
    sessionMocks.getAuth.mockResolvedValueOnce(null);
    const res = await callPost(makePngFile());
    expect(res.status).toBe(401);
    expect(dbMocks.prisma.candidate.findUnique).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// DELETE
// ────────────────────────────────────────────────────────────────────────────

describe("DELETE /api/candidates/[id]/photo", () => {
  it("clears photoFileId and deletes the CandidateFile when a photo exists", async () => {
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce(
      mockCandidate({ photoFileId: "existing-photo" }),
    );

    const tx = {
      candidate: { update: vi.fn().mockResolvedValue({}) },
      candidateFile: { delete: vi.fn().mockResolvedValue({}) },
    };
    dbMocks.prisma.$transaction.mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx));

    const res = await callDelete();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    expect(tx.candidate.update).toHaveBeenCalledWith({
      where: { id: "cand-1" },
      data: { photoFileId: null },
    });
    expect(tx.candidateFile.delete).toHaveBeenCalledWith({ where: { id: "existing-photo" } });
  });

  it("returns 404 when the candidate has no photo", async () => {
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce(mockCandidate({ photoFileId: null }));
    const res = await callDelete();
    expect(res.status).toBe(404);
    expect(dbMocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("returns 404 when the candidate doesn't exist", async () => {
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce(null);
    const res = await callDelete();
    expect(res.status).toBe(404);
    expect(dbMocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("cross-org viewer gets 404 — never delete other-org photos", async () => {
    sessionMocks.getAuth.mockResolvedValueOnce({ userId: "u2", orgId: "org-OTHER", isOwner: false });
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce(
      mockCandidate({ orgId: "org-1", photoFileId: "existing-photo" }),
    );
    const res = await callDelete();
    expect(res.status).toBe(404);
    expect(dbMocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("returns 401 when not authenticated", async () => {
    sessionMocks.getAuth.mockResolvedValueOnce(null);
    const res = await callDelete();
    expect(res.status).toBe(401);
    expect(dbMocks.prisma.candidate.findUnique).not.toHaveBeenCalled();
  });
});
