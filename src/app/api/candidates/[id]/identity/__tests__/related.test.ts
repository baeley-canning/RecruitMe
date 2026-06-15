/**
 * Tests for the read-only merge-review feed:
 *   GET /api/candidates/[id]/identity/related
 *
 * Pins the behaviours the UI depends on:
 *  • 404 when the feature flag is off
 *  • 404 for a cross-org candidate (non-owner)
 *  • hasIdentity:false when the candidate has no CandidateIdentity yet
 *  • suggestions surface email/name matches AND exclude tombstoned pairs
 *    (so the panel never offers a merge the write route would 409 on)
 *  • mergedFrom lists active merges and drops the ones later unmerged
 *
 * All DB interaction mocked through @/lib/db. No real Prisma.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => {
  const candidate = { findUnique: vi.fn(), groupBy: vi.fn(), findMany: vi.fn() };
  const candidateIdentity = { findUnique: vi.fn(), findMany: vi.fn() };
  const candidateIdentityMerge = { findMany: vi.fn() };
  const prisma = { candidate, candidateIdentity, candidateIdentityMerge };
  return { prisma };
});

const sessionMocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  unauthorized: vi.fn(() => new Response(null, { status: 401 })),
}));

vi.hoisted(() => {
  process.env.RECRUITME_IDENTITY_MERGE_UI_ENABLED = "true";
});

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/session", () => sessionMocks);

import { GET } from "@/app/api/candidates/[id]/identity/related/route";

const params = Promise.resolve({ id: "cand-1" });
const req = () => new Request("http://test/api/candidates/cand-1/identity/related");

beforeEach(() => {
  vi.clearAllMocks();
  process.env.RECRUITME_IDENTITY_MERGE_UI_ENABLED = "true";
  sessionMocks.getAuth.mockResolvedValue({ userId: "u1", orgId: "org-A", isOwner: false });
  // Sensible empty defaults; individual tests override with mockResolvedValueOnce.
  dbMocks.prisma.candidate.groupBy.mockResolvedValue([]);
  dbMocks.prisma.candidate.findMany.mockResolvedValue([]);
  dbMocks.prisma.candidateIdentity.findMany.mockResolvedValue([]);
  dbMocks.prisma.candidateIdentityMerge.findMany.mockResolvedValue([]);
});

afterEach(() => {
  process.env.RECRUITME_IDENTITY_MERGE_UI_ENABLED = "true";
});

describe("GET /identity/related — gating", () => {
  it("404s when the flag is off", async () => {
    process.env.RECRUITME_IDENTITY_MERGE_UI_ENABLED = "false";
    const res = await GET(req(), { params });
    expect(res.status).toBe(404);
  });

  it("404s for a cross-org candidate (non-owner)", async () => {
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce({
      id: "cand-1", orgId: "org-B", candidateIdentityId: "ident-cur",
    });
    const res = await GET(req(), { params });
    expect(res.status).toBe(404);
  });

  it("returns hasIdentity:false when the candidate has no identity", async () => {
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce({
      id: "cand-1", orgId: "org-A", candidateIdentityId: null,
    });
    const res = await GET(req(), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ hasIdentity: false, suggestions: [], mergedFrom: [] });
  });
});

describe("GET /identity/related — suggestions + history", () => {
  it("suggests email/name matches, excludes tombstoned pairs, lists active merges", async () => {
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce({
      id: "cand-1", orgId: "org-A", candidateIdentityId: "ident-cur",
    });
    dbMocks.prisma.candidateIdentity.findUnique.mockResolvedValueOnce({
      id: "ident-cur", canonicalName: "Jane Doe", primaryEmail: "jane@x.com",
      primaryPhone: null, linkedinUrl: null, jobAdderUrl: null, seekUrl: null,
    });
    // candidateMatches (first candidateIdentity.findMany): a real dup + a
    // tombstoned one that must be filtered out.
    dbMocks.prisma.candidateIdentity.findMany
      .mockResolvedValueOnce([
        { id: "ident-dup", canonicalName: "Jane Doe", primaryEmail: "jane@x.com", primaryPhone: null, linkedinUrl: null, jobAdderUrl: null, seekUrl: null },
        { id: "ident-blocked", canonicalName: "Jane Doe", primaryEmail: "jane@x.com", primaryPhone: null, linkedinUrl: null, jobAdderUrl: null, seekUrl: null },
      ])
      // mergedFromNames (second candidateIdentity.findMany)
      .mockResolvedValueOnce([{ id: "ident-old", canonicalName: "J. Doe" }]);
    // merge.findMany call order: tombstones, then mergedInRows, then tombstonedIn
    dbMocks.prisma.candidateIdentityMerge.findMany
      .mockResolvedValueOnce([{ sourceIdentityId: "ident-cur", survivorIdentityId: "ident-blocked" }]) // tombstone blocks ident-blocked
      .mockResolvedValueOnce([{ sourceIdentityId: "ident-old", mergedAt: new Date("2026-01-02T00:00:00Z"), reason: "recruiter_confirm" }]) // active merged-in
      .mockResolvedValueOnce([]); // none later unmerged
    // buildSummaries: groupBy counts + sample candidates
    dbMocks.prisma.candidate.groupBy.mockResolvedValueOnce([
      { candidateIdentityId: "ident-cur", _count: { _all: 3 } },
      { candidateIdentityId: "ident-dup", _count: { _all: 1 } },
    ]);
    dbMocks.prisma.candidate.findMany.mockResolvedValueOnce([
      { id: "c-cur", name: "Jane Doe", headline: null, candidateIdentityId: "ident-cur", archivedJobTitle: "Dev", job: null },
      { id: "c-dup", name: "Jane D", headline: null, candidateIdentityId: "ident-dup", archivedJobTitle: null, job: { title: "Engineer" } },
    ]);

    const res = await GET(req(), { params });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.hasIdentity).toBe(true);
    expect(body.current.candidateCount).toBe(3);

    // Exactly one suggestion — the tombstoned pair is excluded.
    expect(body.suggestions).toHaveLength(1);
    expect(body.suggestions[0].identityId).toBe("ident-dup");
    expect(body.suggestions[0].matchReasons).toEqual(expect.arrayContaining(["email", "name"]));
    expect(body.suggestions.some((s: { identityId: string }) => s.identityId === "ident-blocked")).toBe(false);

    // Merge history surfaces the active merge for unmerge.
    expect(body.mergedFrom).toHaveLength(1);
    expect(body.mergedFrom[0]).toMatchObject({ originalIdentityId: "ident-old", canonicalName: "J. Doe" });
  });

  it("drops merged-in identities that were later unmerged (tombstoned)", async () => {
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce({
      id: "cand-1", orgId: "org-A", candidateIdentityId: "ident-cur",
    });
    dbMocks.prisma.candidateIdentity.findUnique.mockResolvedValueOnce({
      id: "ident-cur", canonicalName: "Jane Doe", primaryEmail: null,
      primaryPhone: null, linkedinUrl: null, jobAdderUrl: null, seekUrl: null,
    });
    // canonicalName is set, so one orFilter exists → matches query runs (return none).
    // With zero matches the tombstone (suggestions) query is skipped, so
    // merge.findMany is only called for mergedIn then tombstonedIn.
    dbMocks.prisma.candidateIdentity.findMany.mockResolvedValueOnce([]);
    dbMocks.prisma.candidateIdentityMerge.findMany
      .mockResolvedValueOnce([{ sourceIdentityId: "ident-old", mergedAt: new Date("2026-01-02T00:00:00Z"), reason: "recruiter_confirm" }]) // merged in
      .mockResolvedValueOnce([{ sourceIdentityId: "ident-old" }]); // ...but later unmerged
    dbMocks.prisma.candidate.groupBy.mockResolvedValueOnce([{ candidateIdentityId: "ident-cur", _count: { _all: 1 } }]);

    const res = await GET(req(), { params });
    const body = await res.json();
    expect(body.mergedFrom).toHaveLength(0);
  });
});
