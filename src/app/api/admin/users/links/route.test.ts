import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    authToken: { create: vi.fn() },
    user: { findUnique: vi.fn() },
    org: { findUnique: vi.fn() },
  },
}));

const sessionMocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("next-auth", () => ({ getServerSession: sessionMocks.getServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));

import { POST } from "./route";

function req(body: unknown) {
  return new Request("https://app.example.com/api/admin/users/links", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("admin auth-link generation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NEXTAUTH_URL;
    sessionMocks.getServerSession.mockResolvedValue({ user: { role: "owner", id: "owner-1" } });
    dbMocks.prisma.authToken.create.mockResolvedValue({ id: "tok-1" });
  });

  it("403s for non-owners", async () => {
    sessionMocks.getServerSession.mockResolvedValue({ user: { role: "user", id: "u-1" } });
    const res = await POST(req({ kind: "invite" }));
    expect(res.status).toBe(403);
    expect(dbMocks.prisma.authToken.create).not.toHaveBeenCalled();
  });

  it("creates an invite link scoped to the org, storing only the token HASH", async () => {
    dbMocks.prisma.org.findUnique.mockResolvedValue({ id: "org-1" });
    const res = await POST(req({ kind: "invite", orgId: "org-1", role: "user" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.url).toMatch(/^https:\/\/app\.example\.com\/join\/[A-Za-z0-9_-]{20,}$/);

    const created = dbMocks.prisma.authToken.create.mock.calls[0][0].data as Record<string, unknown>;
    expect(created.kind).toBe("invite");
    expect(created.orgId).toBe("org-1");
    // sha256 hex — and NOT the raw token from the URL.
    const raw = (body.url as string).split("/join/")[1];
    expect(created.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(created.tokenHash).not.toBe(raw);
  });

  it("404s an invite for a nonexistent org", async () => {
    dbMocks.prisma.org.findUnique.mockResolvedValue(null);
    const res = await POST(req({ kind: "invite", orgId: "org-nope", role: "user" }));
    expect(res.status).toBe(404);
  });

  it("creates a reset link for an existing user (and 404s an unknown one)", async () => {
    dbMocks.prisma.user.findUnique.mockResolvedValueOnce({ id: "u-1", username: "matt" });
    const res = await POST(req({ kind: "reset", userId: "u-1" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.url).toContain("/reset-password/");
    expect(body.username).toBe("matt");

    dbMocks.prisma.user.findUnique.mockResolvedValueOnce(null);
    expect((await POST(req({ kind: "reset", userId: "u-ghost" }))).status).toBe(404);
  });

  it("prefers NEXTAUTH_URL for the link base when set", async () => {
    process.env.NEXTAUTH_URL = "https://recruitme.example.nz/";
    dbMocks.prisma.org.findUnique.mockResolvedValue({ id: "org-1" });
    const res = await POST(req({ kind: "invite", orgId: "org-1", role: "user" }));
    const body = await res.json();
    expect(body.url).toMatch(/^https:\/\/recruitme\.example\.nz\/join\//);
    delete process.env.NEXTAUTH_URL;
  });
});
