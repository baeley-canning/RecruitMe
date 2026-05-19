/**
 * Route-level tests for inline CV preview support on
 * /api/candidates/[id]/files/[fileId].
 *
 * Why the route, not the component: the component is a thin <object> wrapper
 * with a fallback download card — the real risk is in how the server decides
 * whether to serve `Content-Disposition: inline` vs `attachment`, and whether
 * the existing security guarantees (allow-list MIME flattening, nosniff,
 * org-scoped auth, AES-256-GCM decrypt) still hold when `?inline=1` is passed.
 *
 * Mock shape follows src/lib/__tests__/library-empty-profile-integration.test.ts
 * (vi.hoisted + vi.mock); encryption is stubbed identically to
 * src/app/api/candidates/[id]/files/route.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    candidateFile: {
      findFirst: vi.fn(),
    },
  },
}));

const sessionMocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  unauthorized: vi.fn(() => new Response(null, { status: 401 })),
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/session", () => sessionMocks);
// Stub encryption: the inline-vs-attachment decision is independent of the
// decrypt path, so a passthrough mock keeps the test focused.
vi.mock("@/lib/cv-encryption", () => ({
  decryptCv: vi.fn(async (s: string) => Buffer.from(s, "utf8").toString("base64")),
  isEncrypted: () => true,
  maybeMigrateLegacy: vi.fn().mockResolvedValue(undefined),
}));

import { GET } from "@/app/api/candidates/[id]/files/[fileId]/route";

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function mockFile(overrides: Partial<{ mimeType: string; filename: string }> = {}) {
  return {
    id: "file-1",
    candidateId: "cand-1",
    filename: "resume.pdf",
    mimeType: "application/pdf",
    data: "hello-cv-bytes",
    candidate: { orgId: "org-1", job: { orgId: "org-1" } },
    ...overrides,
  };
}

async function call(url: string) {
  return GET(new Request(url), {
    params: Promise.resolve({ id: "cand-1", fileId: "file-1" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionMocks.getAuth.mockResolvedValue({
    userId: "u1",
    orgId: "org-1",
    isOwner: false,
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe("GET /api/candidates/[id]/files/[fileId] — inline preview", () => {
  it("without ?inline=1 → Content-Disposition: attachment (existing behaviour)", async () => {
    dbMocks.prisma.candidateFile.findFirst.mockResolvedValueOnce(mockFile());
    const res = await call("http://localhost/api/candidates/cand-1/files/file-1");
    expect(res.status).toBe(200);
    const cd = res.headers.get("Content-Disposition") ?? "";
    expect(cd.startsWith("attachment")).toBe(true);
    expect(cd).toContain("resume.pdf");
  });

  it("with ?inline=1 on a PDF → Content-Disposition: inline", async () => {
    dbMocks.prisma.candidateFile.findFirst.mockResolvedValueOnce(mockFile());
    const res = await call(
      "http://localhost/api/candidates/cand-1/files/file-1?inline=1",
    );
    expect(res.status).toBe(200);
    const cd = res.headers.get("Content-Disposition") ?? "";
    expect(cd.startsWith("inline")).toBe(true);
    expect(cd).toContain("resume.pdf");
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    // Sanity: nosniff stays on for both branches.
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("with ?inline=1 on a Word doc → forced back to attachment (not inline-safe)", async () => {
    dbMocks.prisma.candidateFile.findFirst.mockResolvedValueOnce(
      mockFile({
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename: "resume.docx",
      }),
    );
    const res = await call(
      "http://localhost/api/candidates/cand-1/files/file-1?inline=1",
    );
    expect(res.status).toBe(200);
    const cd = res.headers.get("Content-Disposition") ?? "";
    expect(cd.startsWith("attachment")).toBe(true);
    // The MIME isn't flattened — it's in ALLOWED_DOWNLOAD_MIMES — but it
    // isn't inline-safe so the disposition is still attachment.
    expect(res.headers.get("Content-Type")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  it("with ?inline=1 on text/html → safeDownloadMime forces octet-stream AND disposition stays attachment", async () => {
    dbMocks.prisma.candidateFile.findFirst.mockResolvedValueOnce(
      mockFile({ mimeType: "text/html", filename: "malicious.html" }),
    );
    const res = await call(
      "http://localhost/api/candidates/cand-1/files/file-1?inline=1",
    );
    expect(res.status).toBe(200);
    // text/html isn't on the download allow-list at all → flattened.
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    // And it isn't inline-safe → attachment regardless of the inline flag.
    const cd = res.headers.get("Content-Disposition") ?? "";
    expect(cd.startsWith("attachment")).toBe(true);
  });

  it("with ?inline=1 on application/msword → attachment (legacy Word also not inline-safe)", async () => {
    dbMocks.prisma.candidateFile.findFirst.mockResolvedValueOnce(
      mockFile({ mimeType: "application/msword", filename: "old.doc" }),
    );
    const res = await call(
      "http://localhost/api/candidates/cand-1/files/file-1?inline=1",
    );
    expect(res.status).toBe(200);
    const cd = res.headers.get("Content-Disposition") ?? "";
    expect(cd.startsWith("attachment")).toBe(true);
  });

  it("cross-org viewer gets 404 even with ?inline=1 (auth check unchanged)", async () => {
    sessionMocks.getAuth.mockResolvedValue({
      userId: "u2",
      orgId: "org-OTHER",
      isOwner: false,
    });
    // requireFileAccess does a `findFirst` then compares orgId. The route
    // returns null on mismatch → 404. Simulate that mismatch:
    dbMocks.prisma.candidateFile.findFirst.mockResolvedValueOnce(mockFile());

    const res = await call(
      "http://localhost/api/candidates/cand-1/files/file-1?inline=1",
    );
    expect(res.status).toBe(404);
    // No content-disposition leaked on the 404 path.
    expect(res.headers.get("Content-Disposition")).toBeNull();
  });

  it("unauthenticated request → 401, regardless of ?inline=1", async () => {
    sessionMocks.getAuth.mockResolvedValueOnce(null);
    const res = await call(
      "http://localhost/api/candidates/cand-1/files/file-1?inline=1",
    );
    expect(res.status).toBe(401);
    // findFirst must never be reached on the unauth path — pin that the
    // auth gate runs before any DB read.
    expect(dbMocks.prisma.candidateFile.findFirst).not.toHaveBeenCalled();
  });
});
