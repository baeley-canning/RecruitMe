import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    orgAccessGrant: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/db", () => dbMocks);

import { getAccessibleOrgIds, candidateOrgFilter, invalidateAccessCache, getGrantScopes, LIBRARY_FULL_SENSITIVE_FIELDS } from "../org-access";

const baseAuth = { userId: "u1", orgId: "org-A", isOwner: false };

describe("getAccessibleOrgIds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateAccessCache("org-A"); // wipe cache between tests
    invalidateAccessCache("org-B");
  });

  it("returns null for owners (no filter — owners see everything)", async () => {
    const ids = await getAccessibleOrgIds({ ...baseAuth, isOwner: true });
    expect(ids).toBeNull();
    // Should not even hit the DB.
    expect(dbMocks.prisma.orgAccessGrant.findMany).not.toHaveBeenCalled();
  });

  it("returns just the caller's own orgId when no grants exist", async () => {
    dbMocks.prisma.orgAccessGrant.findMany.mockResolvedValue([]);
    const ids = await getAccessibleOrgIds(baseAuth);
    expect(ids).toEqual(["org-A"]);
  });

  it("includes provider orgIds from active library_read grants", async () => {
    dbMocks.prisma.orgAccessGrant.findMany.mockResolvedValue([
      { providerOrgId: "org-B", scope: "library_read" },
      { providerOrgId: "org-C", scope: "library_read" },
    ]);
    const ids = await getAccessibleOrgIds(baseAuth);
    expect(ids).toEqual(["org-A", "org-B", "org-C"]);
  });

  it("ignores grants whose scope isn't library_read (forward compatibility)", async () => {
    dbMocks.prisma.orgAccessGrant.findMany.mockResolvedValue([
      { providerOrgId: "org-B", scope: "library_read" },
      { providerOrgId: "org-D", scope: "library_full" }, // future scope
    ]);
    const ids = await getAccessibleOrgIds(baseAuth);
    expect(ids).toEqual(["org-A", "org-B"]);
  });

  it("excludes expired grants via the where-clause filter", async () => {
    // We can't test expiry in this unit (filter is in Prisma where), but we
    // verify the filter shape was passed correctly.
    dbMocks.prisma.orgAccessGrant.findMany.mockResolvedValue([]);
    await getAccessibleOrgIds(baseAuth);
    expect(dbMocks.prisma.orgAccessGrant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          viewerOrgId: "org-A",
          OR: [
            { expiresAt: null },
            { expiresAt: { gt: expect.any(Date) } },
          ],
        }),
      })
    );
  });

  it("caches subsequent calls — second invocation does not re-query the DB", async () => {
    dbMocks.prisma.orgAccessGrant.findMany.mockResolvedValue([
      { providerOrgId: "org-B", scope: "library_read" },
    ]);
    const first = await getAccessibleOrgIds(baseAuth);
    const second = await getAccessibleOrgIds(baseAuth);
    expect(first).toEqual(second);
    expect(dbMocks.prisma.orgAccessGrant.findMany).toHaveBeenCalledTimes(1);
  });

  it("invalidateAccessCache forces a fresh fetch", async () => {
    dbMocks.prisma.orgAccessGrant.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ providerOrgId: "org-B", scope: "library_read" }]);

    const first = await getAccessibleOrgIds(baseAuth);
    expect(first).toEqual(["org-A"]);

    invalidateAccessCache("org-A");
    const second = await getAccessibleOrgIds(baseAuth);
    expect(second).toEqual(["org-A", "org-B"]);
    expect(dbMocks.prisma.orgAccessGrant.findMany).toHaveBeenCalledTimes(2);
  });

  it("returns empty array when caller has no orgId (defensive)", async () => {
    const ids = await getAccessibleOrgIds({ userId: "u1", orgId: null, isOwner: false });
    expect(ids).toEqual([]);
    expect(dbMocks.prisma.orgAccessGrant.findMany).not.toHaveBeenCalled();
  });
});

describe("getGrantScopes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateAccessCache("org-A");
  });

  it("returns every known scope for owners (synthetic — no DB hit)", async () => {
    const scopes = await getGrantScopes({ ...baseAuth, isOwner: true });
    expect(scopes.has("library_read")).toBe(true);
    expect(scopes.has("library_full")).toBe(true);
    expect(dbMocks.prisma.orgAccessGrant.findMany).not.toHaveBeenCalled();
  });

  it("returns an empty set when caller has no orgId", async () => {
    const scopes = await getGrantScopes({ userId: "u1", orgId: null, isOwner: false });
    expect(scopes.size).toBe(0);
    expect(dbMocks.prisma.orgAccessGrant.findMany).not.toHaveBeenCalled();
  });

  it("returns the union of scopes across all grants", async () => {
    dbMocks.prisma.orgAccessGrant.findMany.mockResolvedValue([
      { scope: "library_read" },
      { scope: "library_read" }, // duplicates are de-duped by the Set
      { scope: "library_full" },
    ]);
    const scopes = await getGrantScopes(baseAuth);
    expect([...scopes].sort()).toEqual(["library_full", "library_read"]);
  });

  it("returns an empty set when no grants exist", async () => {
    dbMocks.prisma.orgAccessGrant.findMany.mockResolvedValue([]);
    const scopes = await getGrantScopes(baseAuth);
    expect(scopes.size).toBe(0);
  });
});

describe("LIBRARY_FULL_SENSITIVE_FIELDS", () => {
  it("lists every field the cross-org library_read viewer must NOT see", () => {
    // Tightening this list later requires updating both the caller-side null
    // logic and this assertion deliberately — it's a privacy gate.
    expect(LIBRARY_FULL_SENSITIVE_FIELDS).toEqual(["notes", "screeningData", "interviewNotes"]);
  });
});

describe("candidateOrgFilter", () => {
  it("returns no filter when accessibleOrgIds is null (owner)", () => {
    expect(candidateOrgFilter(null)).toEqual({});
  });

  it("returns a never-match filter when accessibleOrgIds is empty", () => {
    expect(candidateOrgFilter([])).toEqual({ orgId: "__none__" });
  });

  it("filters by job.orgId OR jobless candidate orgId", () => {
    expect(candidateOrgFilter(["org-A", "org-B"])).toEqual({
      OR: [
        { job: { orgId: { in: ["org-A", "org-B"] } } },
        { jobId: null, orgId: { in: ["org-A", "org-B"] } },
      ],
    });
  });
});
