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

  it("creates a saved search and trims/caps inputs", async () => {
    dbMocks.prisma.savedSearch.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "s2", ...data,
    }));
    const longName = "X".repeat(200);
    const res = await POST(new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `  ${longName}  `,
        queries: ["  q1  ", "", "q2"],
        location: "  Wellington  ",
        target: 50,
      }),
    }), { params: Promise.resolve({ id: "job-1" }) });
    expect(res.status).toBe(200);
    const call = dbMocks.prisma.savedSearch.create.mock.calls[0][0];
    expect(call.data.name.length).toBeLessThanOrEqual(100);   // capped
    expect(call.data.name).toBe(longName.slice(0, 100));      // trimmed then sliced
    expect(JSON.parse(call.data.queries)).toEqual(["q1", "q2"]); // empties dropped
    expect(call.data.location).toBe("Wellington");
    expect(call.data.target).toBe(50);
    expect(call.data.orgId).toBe("org-1");
  });

  it("clamps invalid target to default 20", async () => {
    dbMocks.prisma.savedSearch.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "s", ...data }));
    const res = await POST(new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "n", queries: ["q"], location: "Wellington", target: 9999 }),
    }), { params: Promise.resolve({ id: "job-1" }) });
    expect(res.status).toBe(200);
    expect(dbMocks.prisma.savedSearch.create.mock.calls[0][0].data.target).toBe(20);
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
