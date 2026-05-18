import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  prisma: { job: { update: vi.fn() } },
}));

const sessionMocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  requireJobAccess: vi.fn(),
  unauthorized: vi.fn(() => new Response(null, { status: 401 })),
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/session", () => sessionMocks);

import { GET, POST, DELETE } from "./route";

describe("shortlist share route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionMocks.getAuth.mockResolvedValue({ userId: "u1", orgId: "org-1" });
    sessionMocks.requireJobAccess.mockResolvedValue({
      job: { id: "job-1", shareToken: null },
      error: null,
    });
  });

  it("POST generates a fresh, sufficiently-long token", async () => {
    dbMocks.prisma.job.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "job-1", ...data,
    }));
    const res = await POST(new Request("http://localhost/"), {
      params: Promise.resolve({ id: "job-1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // 32 random bytes → 43-char URL-safe base64
    expect(body.token).toHaveLength(43);
    // base64url alphabet only — must NOT contain +, /, or =
    expect(body.token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("POST writes the token to the job row", async () => {
    dbMocks.prisma.job.update.mockResolvedValue({ id: "job-1" });
    await POST(new Request("http://localhost/"), {
      params: Promise.resolve({ id: "job-1" }),
    });
    const call = dbMocks.prisma.job.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: "job-1" });
    expect(typeof call.data.shareToken).toBe("string");
    expect((call.data.shareToken as string).length).toBe(43);
  });

  it("DELETE clears the token", async () => {
    dbMocks.prisma.job.update.mockResolvedValue({ id: "job-1" });
    const res = await DELETE(new Request("http://localhost/"), {
      params: Promise.resolve({ id: "job-1" }),
    });
    expect(res.status).toBe(200);
    // DELETE clears both the token and its expiry stamp.
    expect(dbMocks.prisma.job.update.mock.calls[0][0].data).toEqual({
      shareToken: null,
      shareTokenExpiresAt: null,
    });
  });

  it("GET returns the current token (or null)", async () => {
    sessionMocks.requireJobAccess.mockResolvedValue({
      job: { id: "job-1", shareToken: "abc123" },
      error: null,
    });
    const res = await GET(new Request("http://localhost/"), {
      params: Promise.resolve({ id: "job-1" }),
    });
    const body = await res.json();
    expect(body.token).toBe("abc123");
  });

  it("returns 401 when not authed", async () => {
    sessionMocks.getAuth.mockResolvedValue(null);
    const res = await POST(new Request("http://localhost/"), {
      params: Promise.resolve({ id: "job-1" }),
    });
    expect(res.status).toBe(401);
  });
});
