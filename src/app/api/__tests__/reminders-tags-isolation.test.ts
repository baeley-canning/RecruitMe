/**
 * Lock-down tests for the reminders + tags routes shipped this cycle.
 * Pins the two invariants that must never silently break:
 *   • flag-gating — every route 404s when FEATURES_REMINDERS_ENABLED is off
 *   • org isolation — non-owners are scoped to their own org; cross-org
 *     writes are refused; FK args (candidate/client/placement) are
 *     ownership-checked; an owner sees everything.
 *
 * All DB / session / org-access interaction mocked. No real Prisma.
 */

import { beforeEach, afterAll, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => {
  const candidateTag = { findMany: vi.fn(), create: vi.fn() };
  const reminder = { findMany: vi.fn(), create: vi.fn() };
  const candidate = { findFirst: vi.fn() };
  const candidateTagAssignment = { deleteMany: vi.fn(), createMany: vi.fn(), findMany: vi.fn() };
  const prisma = {
    candidateTag, reminder, candidate, candidateTagAssignment,
    $transaction: vi.fn(async (ops: unknown) => (Array.isArray(ops) ? Promise.all(ops) : ops)),
  };
  return { prisma };
});

const sessionMocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  unauthorized: vi.fn(() => new Response(null, { status: 401 })),
  requireJobAccess: vi.fn(),
}));

const orgAccessMocks = vi.hoisted(() => ({
  getAccessibleOrgIds: vi.fn(),
  candidateOrgFilter: vi.fn((ids: string[] | null) => (ids ? { orgId: { in: ids } } : {})),
}));

// Capture the pre-existing value before forcing the flag on, so afterAll can
// restore it — otherwise "true" leaks into whatever test file runs next in
// this worker and flips reminders/tags routes on for tests that expect off.
const ORIGINAL_FLAG = vi.hoisted(() => {
  const prev = process.env.FEATURES_REMINDERS_ENABLED;
  process.env.FEATURES_REMINDERS_ENABLED = "true";
  return prev;
});

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/session", () => sessionMocks);
vi.mock("@/lib/org-access", () => orgAccessMocks);

import { GET as tagsGET, POST as tagsPOST } from "@/app/api/candidates/tags/route";
import { GET as remindersGET, POST as remindersPOST } from "@/app/api/reminders/route";
import { PUT as candTagsPUT } from "@/app/api/candidates/[id]/tags/route";

const NON_OWNER = { userId: "u1", orgId: "org-A", isOwner: false };
const OWNER = { userId: "owner", orgId: "org-A", isOwner: true };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FEATURES_REMINDERS_ENABLED = "true";
  sessionMocks.getAuth.mockResolvedValue(NON_OWNER);
  orgAccessMocks.getAccessibleOrgIds.mockResolvedValue(["org-A"]);
  orgAccessMocks.candidateOrgFilter.mockImplementation((ids: string[] | null) => (ids ? { orgId: { in: ids } } : {}));
});
afterAll(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.FEATURES_REMINDERS_ENABLED;
  else process.env.FEATURES_REMINDERS_ENABLED = ORIGINAL_FLAG;
});

const json = (url: string, method = "GET", body?: unknown) =>
  new Request(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) });

describe("flag-gating — everything 404s when reminders are off", () => {
  beforeEach(() => { process.env.FEATURES_REMINDERS_ENABLED = "false"; });

  it("tags GET", async () => expect((await tagsGET()).status).toBe(404));
  it("tags POST", async () => expect((await tagsPOST(json("http://t/api/candidates/tags", "POST", { label: "x" }))).status).toBe(404));
  it("reminders GET", async () => expect((await remindersGET(json("http://t/api/reminders"))).status).toBe(404));
  it("reminders POST", async () =>
    expect((await remindersPOST(json("http://t/api/reminders", "POST", { dueAt: "2026-07-01T00:00:00Z" }))).status).toBe(404));
  it("candidate tags PUT", async () => {
    const res = await candTagsPUT(json("http://t/api/candidates/c1/tags", "PUT", { tagIds: [] }), { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(404);
  });
});

describe("tags GET — org scoping", () => {
  it("non-owner is scoped to their own org", async () => {
    dbMocks.prisma.candidateTag.findMany.mockResolvedValueOnce([]);
    await tagsGET();
    expect(dbMocks.prisma.candidateTag.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId: "org-A" } }),
    );
  });

  it("owner sees all orgs (no orgId filter)", async () => {
    sessionMocks.getAuth.mockResolvedValueOnce(OWNER);
    dbMocks.prisma.candidateTag.findMany.mockResolvedValueOnce([]);
    await tagsGET();
    expect(dbMocks.prisma.candidateTag.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} }),
    );
  });
});

describe("tags POST — stamps caller's org", () => {
  it("creates the tag under the caller's orgId", async () => {
    dbMocks.prisma.candidateTag.create.mockResolvedValueOnce({ id: "t1" });
    const res = await tagsPOST(json("http://t/api/candidates/tags", "POST", { label: "Hot", color: "#0a84ff" }));
    expect(res.status).toBe(201);
    expect(dbMocks.prisma.candidateTag.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ orgId: "org-A", label: "Hot" }),
    });
  });
});

describe("reminders GET — org scoping", () => {
  it("non-owner scoped to org + non-dismissed by default", async () => {
    dbMocks.prisma.reminder.findMany.mockResolvedValueOnce([]);
    await remindersGET(json("http://t/api/reminders"));
    expect(dbMocks.prisma.reminder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId: "org-A", dismissed: false } }),
    );
  });
});

describe("reminders POST — FK ownership", () => {
  it("404s when candidateId belongs to another org", async () => {
    dbMocks.prisma.candidate.findFirst.mockResolvedValueOnce(null); // not in caller's org
    const res = await remindersPOST(json("http://t/api/reminders", "POST", {
      dueAt: "2026-07-01T00:00:00Z", candidateId: "cand-other",
    }));
    expect(res.status).toBe(404);
    expect(dbMocks.prisma.reminder.create).not.toHaveBeenCalled();
  });

  it("creates when the FK is in the caller's org", async () => {
    dbMocks.prisma.candidate.findFirst.mockResolvedValueOnce({ id: "cand-mine" });
    dbMocks.prisma.reminder.create.mockResolvedValueOnce({ id: "r1" });
    const res = await remindersPOST(json("http://t/api/reminders", "POST", {
      dueAt: "2026-07-01T00:00:00Z", candidateId: "cand-mine",
    }));
    expect(res.status).toBe(201);
    expect(dbMocks.prisma.reminder.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ orgId: "org-A", userId: "u1" }),
    });
  });
});

describe("candidate tags PUT — cross-org write is refused", () => {
  it("a read-grant holder (candidate in another org) cannot rewrite tags", async () => {
    // Read grant: candidate resolves, but it lives in org-B while caller is org-A.
    orgAccessMocks.getAccessibleOrgIds.mockResolvedValueOnce(["org-A", "org-B"]);
    dbMocks.prisma.candidate.findFirst.mockResolvedValueOnce({ id: "c1", orgId: "org-B", job: null });
    const res = await candTagsPUT(
      json("http://t/api/candidates/c1/tags", "PUT", { tagIds: ["t1"] }),
      { params: Promise.resolve({ id: "c1" }) },
    );
    expect(res.status).toBe(404);
    expect(dbMocks.prisma.candidateTagAssignment.deleteMany).not.toHaveBeenCalled();
  });

  it("constrains assigned tagIds to the candidate's own org", async () => {
    dbMocks.prisma.candidate.findFirst.mockResolvedValueOnce({ id: "c1", orgId: "org-A", job: null });
    // validTags query: only t-mine belongs to org-A; t-foreign is filtered out by the route's where.
    dbMocks.prisma.candidateTag.findMany.mockResolvedValueOnce([{ id: "t-mine" }]);
    dbMocks.prisma.candidateTagAssignment.findMany.mockResolvedValueOnce([{ tag: { id: "t-mine", label: "x", color: "#fff" } }]);
    const res = await candTagsPUT(
      json("http://t/api/candidates/c1/tags", "PUT", { tagIds: ["t-mine", "t-foreign"] }),
      { params: Promise.resolve({ id: "c1" }) },
    );
    expect(res.status).toBe(200);
    // The org constraint must be in the validTags lookup.
    expect(dbMocks.prisma.candidateTag.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ orgId: "org-A", id: { in: ["t-mine", "t-foreign"] } }) }),
    );
    // Only the in-org tag is assigned.
    expect(dbMocks.prisma.candidateTagAssignment.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: [{ candidateId: "c1", tagId: "t-mine" }] }),
    );
  });
});
