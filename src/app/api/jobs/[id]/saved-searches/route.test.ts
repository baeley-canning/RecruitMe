import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    savedSearch: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
  },
}));

const sessionMocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  requireJobAccess: vi.fn(),
  unauthorized: vi.fn(() => new Response(null, { status: 401 })),
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/session", () => sessionMocks);

import { GET, POST } from "./route";

describe("saved-searches list/create route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionMocks.getAuth.mockResolvedValue({ userId: "u1", orgId: "org-1" });
    sessionMocks.requireJobAccess.mockResolvedValue({
      job: { id: "job-1", orgId: "org-1" },
      error: null,
    });
  });

  it("returns 401 when not authed", async () => {
    sessionMocks.getAuth.mockResolvedValue(null);
    const res = await GET(new Request("http://localhost/"), {
      params: Promise.resolve({ id: "job-1" }),
    });
    expect(res.status).toBe(401);
  });

  it("lists saved searches for the job", async () => {
    dbMocks.prisma.savedSearch.findMany.mockResolvedValue([
      { id: "s1", name: "React leads", queries: '["a","b"]', location: "Auckland", target: 20, lastRunAt: null, lastResultCount: null, createdAt: new Date() },
    ]);
    const res = await GET(new Request("http://localhost/"), {
      params: Promise.resolve({ id: "job-1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe("React leads");
    expect(dbMocks.prisma.savedSearch.findMany.mock.calls[0][0].where).toEqual({ jobId: "job-1" });
  });

  it("rejects POST with missing required fields", async () => {
    const res = await POST(new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    }), { params: Promise.resolve({ id: "job-1" }) });
    expect(res.status).toBe(400);
  });

  it("creates a saved search and trims/dedupes inputs", async () => {
    dbMocks.prisma.savedSearch.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "s2", ...data,
    }));
    const res = await POST(new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "  React leads  ",
        queries: ["  q1  ", "", "q2"],
        location: "  Wellington  ",
        target: 50,
      }),
    }), { params: Promise.resolve({ id: "job-1" }) });
    expect(res.status).toBe(200);
    const call = dbMocks.prisma.savedSearch.create.mock.calls[0][0];
    expect(call.data.name).toBe("React leads");                  // trimmed
    expect(JSON.parse(call.data.queries)).toEqual(["q1", "q2"]); // empties dropped
    expect(call.data.location).toBe("Wellington");
    expect(call.data.target).toBe(50);
    expect(call.data.orgId).toBe("org-1");
  });

  it("rejects name longer than 100 chars with 400 and surfaces the issue path", async () => {
    // Previously the route silently sliced to 100 chars; the Zod schema now
    // rejects oversize names so the client sees the failure explicitly.
    const res = await POST(new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "X".repeat(200),
        queries: ["q1"],
        location: "Wellington",
      }),
    }), { params: Promise.resolve({ id: "job-1" }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid body");
    // Pinning the issue path catches accidental schema regressions — if
    // someone removes the .max(100) constraint the test will fail because
    // the issue path becomes empty.
    expect(Array.isArray(body.issues)).toBe(true);
    const paths = body.issues.map((i: { path: unknown[] }) => i.path.join("."));
    expect(paths).toContain("name");
  });

  it("defaults target to 20 when omitted, and rejects out-of-range target", async () => {
    dbMocks.prisma.savedSearch.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "s", ...data }));

    // Omitted → defaults to 20.
    const okRes = await POST(new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "n", queries: ["q"], location: "Wellington" }),
    }), { params: Promise.resolve({ id: "job-1" }) });
    expect(okRes.status).toBe(200);
    expect(dbMocks.prisma.savedSearch.create.mock.calls[0][0].data.target).toBe(20);

    // Out-of-range → rejected (was previously silently clamped).
    const badRes = await POST(new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "n", queries: ["q"], location: "Wellington", target: 9999 }),
    }), { params: Promise.resolve({ id: "job-1" }) });
    expect(badRes.status).toBe(400);
  });

  it("returns 409 on duplicate name (P2002)", async () => {
    dbMocks.prisma.savedSearch.create.mockRejectedValue({ code: "P2002" });
    const res = await POST(new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "duplicate", queries: ["q"], location: "Wellington" }),
    }), { params: Promise.resolve({ id: "job-1" }) });
    expect(res.status).toBe(409);
  });
});
