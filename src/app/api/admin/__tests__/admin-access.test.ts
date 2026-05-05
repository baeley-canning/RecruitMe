import { describe, expect, it, vi } from "vitest";

// Mock the new v5 auth() function from @/auth
const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
const dbMocks = vi.hoisted(() => ({
  prisma: {
    user: { findMany: vi.fn().mockResolvedValue([]) },
    org: { findMany: vi.fn().mockResolvedValue([]) },
    usageEvent: {
      groupBy: vi.fn().mockResolvedValue([]),
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

vi.mock("@/auth", () => authMock);
vi.mock("@/lib/db", () => dbMocks);

import { GET as usersGET } from "../users/route";
import { GET as orgsGET } from "../orgs/route";
import { GET as analyticsGET } from "../analytics/route";

function ownerSession() {
  authMock.auth.mockResolvedValue({ user: { role: "owner", id: "owner-1", orgId: null } });
}
function userSession() {
  authMock.auth.mockResolvedValue({ user: { role: "user", id: "user-1", orgId: "org-1" } });
}
function noSession() {
  authMock.auth.mockResolvedValue(null);
}

describe("admin routes — access control", () => {
  it("users: owner can list users", async () => {
    ownerSession();
    const res = await usersGET();
    expect(res.status).toBe(200);
  });

  it("users: non-owner gets 403", async () => {
    userSession();
    const res = await usersGET();
    expect(res.status).toBe(403);
  });

  it("users: unauthenticated gets 403", async () => {
    noSession();
    const res = await usersGET();
    expect(res.status).toBe(403);
  });

  it("orgs: owner can list orgs", async () => {
    ownerSession();
    const res = await orgsGET();
    expect(res.status).toBe(200);
  });

  it("orgs: non-owner gets 403", async () => {
    userSession();
    const res = await orgsGET();
    expect(res.status).toBe(403);
  });

  it("analytics: owner can view analytics", async () => {
    ownerSession();
    const res = await analyticsGET(new Request("http://localhost/api/admin/analytics?days=7"));
    expect(res.status).toBe(200);
  });

  it("analytics: non-owner gets 403", async () => {
    userSession();
    const res = await analyticsGET(new Request("http://localhost/api/admin/analytics?days=7"));
    expect(res.status).toBe(403);
  });
});
