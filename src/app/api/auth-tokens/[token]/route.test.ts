import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    authToken: { findUnique: vi.fn(), updateMany: vi.fn() },
    user: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    org: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/error-reporting", () => ({ reportError: vi.fn() }));

import { GET, POST } from "./route";

const RAW = "test-token-raw-value-that-is-long-enough";
const HASH = createHash("sha256").update(RAW).digest("hex");

function tokenRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "tok-1",
    kind: "invite",
    orgId: "org-1",
    role: "user",
    userId: null,
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: null,
    ...overrides,
  };
}

function req(body?: unknown) {
  return new Request("http://localhost/api/auth-tokens/x", {
    method: body ? "POST" : "GET",
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
}

const params = { params: Promise.resolve({ token: RAW }) };

describe("auth-token link redemption", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // $transaction(callback) → run the callback against the same mock set,
    // like the real interactive transaction would.
    dbMocks.prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(dbMocks.prisma));
    dbMocks.prisma.authToken.updateMany.mockResolvedValue({ count: 1 });
  });

  it("GET returns 404 for an unknown token", async () => {
    dbMocks.prisma.authToken.findUnique.mockResolvedValue(null);
    const res = await GET(req(), params);
    expect(res.status).toBe(404);
  });

  it("GET rejects expired and already-used tokens", async () => {
    dbMocks.prisma.authToken.findUnique.mockResolvedValueOnce(tokenRow({ expiresAt: new Date(Date.now() - 1) }));
    expect((await GET(req(), params)).status).toBe(404);
    dbMocks.prisma.authToken.findUnique.mockResolvedValueOnce(tokenRow({ usedAt: new Date() }));
    expect((await GET(req(), params)).status).toBe(404);
  });

  it("GET describes a valid invite (org name + role) — and looks up by sha256, never the raw token", async () => {
    dbMocks.prisma.authToken.findUnique.mockResolvedValue(tokenRow());
    dbMocks.prisma.org.findUnique.mockResolvedValue({ name: "Acme Recruitment" });
    const res = await GET(req(), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ valid: true, kind: "invite", orgName: "Acme Recruitment", role: "user" });
    expect(dbMocks.prisma.authToken.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: HASH } }),
    );
  });

  it("POST invite creates the user in the token's org with a bcrypt-hashed password and burns the token", async () => {
    dbMocks.prisma.authToken.findUnique.mockResolvedValue(tokenRow());
    dbMocks.prisma.user.findUnique.mockResolvedValue(null); // username free
    dbMocks.prisma.user.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "u-new",
      username: data.username,
    }));

    const res = await POST(req({ username: "sarah", password: "hunter2hunter2!" }), params);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, username: "sarah" });

    const created = dbMocks.prisma.user.create.mock.calls[0][0].data as Record<string, unknown>;
    expect(created.orgId).toBe("org-1");
    expect(created.role).toBe("user");
    expect(created.password).not.toContain("hunter2"); // hashed, never plaintext
    expect(await bcrypt.compare("hunter2hunter2!", created.password as string)).toBe(true);
    // Token burned atomically with the guarded WHERE.
    expect(dbMocks.prisma.authToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "tok-1", usedAt: null } }),
    );
  });

  it("POST invite refuses when the single-use guard loses the race (no user created)", async () => {
    dbMocks.prisma.authToken.findUnique.mockResolvedValue(tokenRow());
    dbMocks.prisma.user.findUnique.mockResolvedValue(null);
    dbMocks.prisma.authToken.updateMany.mockResolvedValue({ count: 0 }); // someone else redeemed first

    const res = await POST(req({ username: "sarah", password: "hunter2hunter2!" }), params);
    expect(res.status).toBe(409);
    expect(dbMocks.prisma.user.create).not.toHaveBeenCalled();
  });

  it("POST invite 409s on a taken username and 422s on a weak password", async () => {
    dbMocks.prisma.authToken.findUnique.mockResolvedValue(tokenRow());
    dbMocks.prisma.user.findUnique.mockResolvedValueOnce({ id: "existing" });
    expect((await POST(req({ username: "sarah", password: "hunter2hunter2!" }), params)).status).toBe(409);

    dbMocks.prisma.authToken.findUnique.mockResolvedValue(tokenRow());
    expect((await POST(req({ username: "sarah", password: "allletters" }), params)).status).toBe(422);
  });

  it("POST reset sets a new bcrypt password for the token's user and burns the token", async () => {
    dbMocks.prisma.authToken.findUnique.mockResolvedValue(tokenRow({ kind: "reset", userId: "u-1", orgId: null }));
    dbMocks.prisma.user.update.mockResolvedValue({ username: "matt" });

    const res = await POST(req({ password: "newpass123!" }), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, username: "matt" });
    const update = dbMocks.prisma.user.update.mock.calls[0][0] as { where: unknown; data: { password: string } };
    expect(update.where).toEqual({ id: "u-1" });
    expect(await bcrypt.compare("newpass123!", update.data.password)).toBe(true);
    expect(dbMocks.prisma.authToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "tok-1", usedAt: null } }),
    );
  });
});
