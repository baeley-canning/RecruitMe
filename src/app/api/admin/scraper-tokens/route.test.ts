import { beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "crypto";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    scraperApiToken: { findMany: vi.fn(), create: vi.fn() },
    org: { findUnique: vi.fn() },
  },
}));
const sessionMocks = vi.hoisted(() => ({ getServerSession: vi.fn() }));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("next-auth", () => ({ getServerSession: sessionMocks.getServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));

import { GET, POST } from "./route";

function req(body: unknown) {
  return new Request("http://localhost/api/admin/scraper-tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("scraper-tokens admin API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionMocks.getServerSession.mockResolvedValue({ user: { role: "owner" } });
    dbMocks.prisma.scraperApiToken.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "tok-1", label: data.label, orgId: data.orgId, expiresAt: data.expiresAt, createdAt: new Date(),
    }));
  });

  it("GET/POST are owner-only (403 for non-owner)", async () => {
    sessionMocks.getServerSession.mockResolvedValue({ user: { role: "user" } });
    expect((await GET()).status).toBe(403);
    expect((await POST(req({ label: "x" }))).status).toBe(403);
    expect(dbMocks.prisma.scraperApiToken.create).not.toHaveBeenCalled();
  });

  it("GET lists tokens with derived status and NEVER exposes the hash", async () => {
    dbMocks.prisma.scraperApiToken.findMany.mockResolvedValue([
      { id: "a", label: "box-a", orgId: "org-1", org: { name: "Acme" }, lastUsedAt: null, revokedAt: null, expiresAt: null, createdAt: new Date() },
      { id: "b", label: "box-b", orgId: null, org: null, lastUsedAt: null, revokedAt: new Date(), expiresAt: null, createdAt: new Date() },
    ]);
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body[0]).toMatchObject({ label: "box-a", orgName: "Acme", status: "active" });
    expect(body[1]).toMatchObject({ label: "box-b", orgName: null, status: "revoked" });
    // The select never requested tokenHash; assert it's absent from the payload.
    expect(body[0].tokenHash).toBeUndefined();
    const selectArg = dbMocks.prisma.scraperApiToken.findMany.mock.calls[0][0].select;
    expect(selectArg.tokenHash).toBeUndefined();
  });

  it("POST mints: stores the HASH (not plaintext) and returns the plaintext ONCE", async () => {
    dbMocks.prisma.org.findUnique.mockResolvedValue({ id: "org-1" });
    const res = await POST(req({ label: "acme-box", orgId: "org-1" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    // plaintext returned once
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(20);
    // what got STORED is the sha256 hash of that plaintext, never the plaintext
    const stored = dbMocks.prisma.scraperApiToken.create.mock.calls[0][0].data as { tokenHash: string; orgId: string; label: string };
    expect(stored.tokenHash).toBe(crypto.createHash("sha256").update(body.token).digest("hex"));
    expect(stored.tokenHash).not.toBe(body.token);
    expect(stored.orgId).toBe("org-1");
  });

  it("POST 404s for a nonexistent org", async () => {
    dbMocks.prisma.org.findUnique.mockResolvedValue(null);
    const res = await POST(req({ label: "x", orgId: "ghost" }));
    expect(res.status).toBe(404);
    expect(dbMocks.prisma.scraperApiToken.create).not.toHaveBeenCalled();
  });

  it("POST sets expiresAt from expiresInDays", async () => {
    const res = await POST(req({ label: "temp", expiresInDays: 30 }));
    expect(res.status).toBe(201);
    const stored = dbMocks.prisma.scraperApiToken.create.mock.calls[0][0].data as { expiresAt: Date | null };
    expect(stored.expiresAt).toBeInstanceOf(Date);
    const days = (stored.expiresAt!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
  });

  it("POST 422s on a missing label", async () => {
    expect((await POST(req({ orgId: "org-1" }))).status).toBe(422);
  });
});
