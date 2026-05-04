import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    job: {
      findUnique: vi.fn(),
      update: vi.fn(),
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

import { POST } from "./route";

function makeParsedRole(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    title: "Software Engineer",
    location: "Wellington",
    must_haves: ["C++", "Sybase"],
    nice_to_haves: ["Linux"],
    knockout_criteria: [],
    skills_required: ["C++", "Sybase"],
    skills_preferred: ["Linux"],
    skill_notes: [
      {
        skill: "Sybase",
        type: "legacy",
        note: "Sybase is largely obsolete.",
        alternatives: ["SAP HANA", "SQL Server", "PostgreSQL"],
      },
    ],
    dismissed_skill_notes: [],
    ...overrides,
  });
}

function makeJob(parsedRoleOverrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    parsedRole: makeParsedRole(parsedRoleOverrides),
  };
}

function postRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/jobs/job-1/skill-note-action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("skill-note-action route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionMocks.getAuth.mockResolvedValue({ userId: "user-1", orgId: "org-1" });
    const job = makeJob();
    sessionMocks.requireJobAccess.mockResolvedValue({ job, error: null });
    dbMocks.prisma.job.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "job-1",
      ...data,
    }));
  });

  it("returns 401 without auth", async () => {
    sessionMocks.getAuth.mockResolvedValue(null);
    const res = await POST(postRequest({ skill: "Sybase", action: "accept", alternative: "SQL Server" }), {
      params: Promise.resolve({ id: "job-1" }),
    });
    expect(res.status).toBe(401);
    expect(dbMocks.prisma.job.update).not.toHaveBeenCalled();
  });

  it("accept adds the alternative to nice_to_haves and skills_preferred", async () => {
    const res = await POST(postRequest({ skill: "Sybase", action: "accept", alternative: "SQL Server" }), {
      params: Promise.resolve({ id: "job-1" }),
    });
    const body = await res.json() as { parsedRole: { nice_to_haves: string[]; skills_preferred: string[] } };

    expect(res.status).toBe(200);
    expect(body.parsedRole.nice_to_haves).toContain("SQL Server");
    expect(body.parsedRole.skills_preferred).toContain("SQL Server");
    expect(dbMocks.prisma.job.update).toHaveBeenCalledTimes(1);
  });

  it("accept preserves existing nice_to_haves entries", async () => {
    const res = await POST(postRequest({ skill: "Sybase", action: "accept", alternative: "SAP HANA" }), {
      params: Promise.resolve({ id: "job-1" }),
    });
    const body = await res.json() as { parsedRole: { nice_to_haves: string[] } };

    expect(body.parsedRole.nice_to_haves).toContain("Linux");
    expect(body.parsedRole.nice_to_haves).toContain("SAP HANA");
  });

  it("accept is idempotent — does not add duplicates", async () => {
    const job = makeJob({ nice_to_haves: ["Linux", "SQL Server"], skills_preferred: ["Linux", "SQL Server"] });
    sessionMocks.requireJobAccess.mockResolvedValue({ job, error: null });

    const res = await POST(postRequest({ skill: "Sybase", action: "accept", alternative: "SQL Server" }), {
      params: Promise.resolve({ id: "job-1" }),
    });
    const body = await res.json() as { parsedRole: { nice_to_haves: string[] } };

    const count = body.parsedRole.nice_to_haves.filter(
      (item: string) => item.toLowerCase() === "sql server"
    ).length;
    expect(count).toBe(1);
  });

  it("accept is case-insensitive for duplicate detection", async () => {
    const job = makeJob({ nice_to_haves: ["sql server"], skills_preferred: ["sql server"] });
    sessionMocks.requireJobAccess.mockResolvedValue({ job, error: null });

    const res = await POST(postRequest({ skill: "Sybase", action: "accept", alternative: "SQL Server" }), {
      params: Promise.resolve({ id: "job-1" }),
    });
    const body = await res.json() as { parsedRole: { nice_to_haves: string[] } };

    const count = body.parsedRole.nice_to_haves.filter(
      (item: string) => item.toLowerCase() === "sql server"
    ).length;
    expect(count).toBe(1);
  });

  it("dismiss adds skill to dismissed_skill_notes", async () => {
    const res = await POST(postRequest({ skill: "Sybase", action: "dismiss" }), {
      params: Promise.resolve({ id: "job-1" }),
    });
    const body = await res.json() as { parsedRole: { dismissed_skill_notes: string[] } };

    expect(res.status).toBe(200);
    expect(body.parsedRole.dismissed_skill_notes).toContain("Sybase");
    expect(dbMocks.prisma.job.update).toHaveBeenCalledTimes(1);
  });

  it("dismiss is idempotent — does not add duplicate dismissed entries", async () => {
    const job = makeJob({ dismissed_skill_notes: ["Sybase"] });
    sessionMocks.requireJobAccess.mockResolvedValue({ job, error: null });

    const res = await POST(postRequest({ skill: "Sybase", action: "dismiss" }), {
      params: Promise.resolve({ id: "job-1" }),
    });
    const body = await res.json() as { parsedRole: { dismissed_skill_notes: string[] } };

    const count = body.parsedRole.dismissed_skill_notes.filter((s: string) => s === "Sybase").length;
    expect(count).toBe(1);
  });

  it("dismiss does not remove nice_to_haves", async () => {
    const res = await POST(postRequest({ skill: "Sybase", action: "dismiss" }), {
      params: Promise.resolve({ id: "job-1" }),
    });
    const body = await res.json() as { parsedRole: { nice_to_haves: string[]; must_haves: string[] } };

    expect(body.parsedRole.nice_to_haves).toContain("Linux");
    expect(body.parsedRole.must_haves).toContain("Sybase");
  });

  it("returns 400 when job has no parsedRole", async () => {
    const job = { id: "job-1", parsedRole: null };
    sessionMocks.requireJobAccess.mockResolvedValue({ job, error: null });

    const res = await POST(postRequest({ skill: "Sybase", action: "dismiss" }), {
      params: Promise.resolve({ id: "job-1" }),
    });
    expect(res.status).toBe(400);
    expect(dbMocks.prisma.job.update).not.toHaveBeenCalled();
  });

  it("returns 422 for invalid action", async () => {
    const res = await POST(postRequest({ skill: "Sybase", action: "unknown" }), {
      params: Promise.resolve({ id: "job-1" }),
    });
    expect(res.status).toBe(422);
    expect(dbMocks.prisma.job.update).not.toHaveBeenCalled();
  });

  it("returns 422 for missing skill", async () => {
    const res = await POST(postRequest({ action: "dismiss" }), {
      params: Promise.resolve({ id: "job-1" }),
    });
    expect(res.status).toBe(422);
  });
});
