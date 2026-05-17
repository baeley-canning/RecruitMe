/**
 * Score-correction `reason` length validation.
 *
 * Current route truncates `reason.slice(0, 500)` rather than rejecting an
 * oversize value via a Zod schema. The audit recommendation is to flip that
 * to a hard `.max(500)` 400 so callers know their long reason was clipped.
 *
 * - The truncation behaviour is asserted live (it's the shipped behaviour
 *   right now).
 * - The "400 on 600-char reason" assertion is `it.skip`'d with a TODO so
 *   Agent X (Zod-schema landing) can flip it on without rewriting the
 *   regression-guard from scratch.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    scoreCorrection: { create: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
  },
}));

const sessionMocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  requireCandidateAccess: vi.fn(),
  unauthorized: vi.fn(() => new Response(null, { status: 401 })),
}));

vi.mock("@/lib/db",      () => dbMocks);
vi.mock("@/lib/session", () => sessionMocks);

import { POST } from "./route";

describe("POST /correct-score — reason length", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionMocks.getAuth.mockResolvedValue({ userId: "u-1", orgId: "org-1" });
    sessionMocks.requireCandidateAccess.mockResolvedValue({
      job: {
        id: "job-1",
        orgId: "org-1",
        parsedRole: JSON.stringify({ title: "Senior Engineer" }),
      },
      candidate: { id: "c-1", orgId: "org-1", matchScore: 70 },
      error: null,
    });
    dbMocks.prisma.scoreCorrection.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "corr-1",
      createdAt: new Date(),
      ...data,
    }));
  });

  it("returns 400 when the reason exceeds 500 chars (Zod .max(500))", async () => {
    // The route now uses Zod safeParse with `reason: z.string().trim().max(500)`
    // — overlong reasons are rejected rather than silently truncated, so the
    // recruiter sees the failure instead of finding a half-pasted note in the
    // audit log days later. Earlier `.slice(0, 500)` behaviour was the bug.
    const longReason = "x".repeat(600);
    const req = new Request("http://localhost/api/jobs/job-1/candidates/c-1/correct-score", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recruiterScore: 85, reason: longReason }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: "job-1", candidateId: "c-1" }) });
    expect(res.status).toBe(400);
    expect(dbMocks.prisma.scoreCorrection.create).not.toHaveBeenCalled();
  });

  it("accepts a 500-char reason without truncation", async () => {
    const exactReason = "z".repeat(500);
    const req = new Request("http://localhost/api/jobs/job-1/candidates/c-1/correct-score", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recruiterScore: 60, reason: exactReason }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: "job-1", candidateId: "c-1" }) });
    expect(res.status).toBe(200);

    const createArg = dbMocks.prisma.scoreCorrection.create.mock.calls[0][0] as { data: { reason: string | null } };
    expect(createArg.data.reason).toBe(exactReason);
  });
});
