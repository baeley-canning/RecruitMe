/**
 * Integration tests for src/lib/insight-cache.ts using mocked Prisma.
 *
 * Pins the three load-bearing invariants of the persistence layer:
 *  • Idempotency: same (orgId, identityId, hash, version) tuple → no new row.
 *  • Supersession: a new hash for an identity marks prior current rows
 *    superseded in the same transaction.
 *  • Multi-org isolation: getCurrentInsight is org-scoped — org B never sees
 *    org A's insight even when identityId is the same string.
 *
 * No real DB. Mocks Prisma client via the established vi.hoisted pattern.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => {
  const profileInsight = {
    findFirst: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
    findFirstOrThrow: vi.fn(),
  };
  const candidateIdentity = {
    updateMany: vi.fn(),
  };
  const prisma = {
    profileInsight,
    candidateIdentity,
    $transaction: vi.fn(async (cb: (tx: typeof prisma) => unknown) => cb(prisma)),
  };
  return { prisma };
});

vi.mock("@/lib/db", () => dbMocks);

import {
  findInsightByKey,
  getCurrentInsight,
  saveInsight,
  supersedeAllInsightsForIdentity,
} from "../insight-cache";
import type { ExtractedInsight } from "../ai/insights";

const FACTS = {
  currentTitle: "Senior Engineer",
  currentEmployer: "Acme",
  primaryStack: ["typescript", "react"],
  secondaryStack: [],
  domains: ["fintech"],
  titlesHeld: ["Senior Engineer"],
  education: [],
  certifications: [],
  evidenceSnippets: [{ field: "currentTitle", value: "Senior Engineer", quote: "Senior Engineer at Acme" }],
};

function buildExtractedInsight(overrides: Partial<ExtractedInsight> = {}): ExtractedInsight {
  return {
    facts: FACTS,
    extractedBy: "claude",
    modelId: "claude-haiku-4-5-20251001",
    sourceProfileTextHash: "hash-A",
    promptVersion: "insight-v1.0",
    extractionVersion: 1,
    ...overrides,
  };
}

beforeEach(() => {
  dbMocks.prisma.profileInsight.findFirst.mockReset();
  dbMocks.prisma.profileInsight.create.mockReset();
  dbMocks.prisma.profileInsight.updateMany.mockReset();
  dbMocks.prisma.profileInsight.findFirstOrThrow.mockReset();
  dbMocks.prisma.candidateIdentity.updateMany.mockReset();
  dbMocks.prisma.profileInsight.updateMany.mockResolvedValue({ count: 0 });
  dbMocks.prisma.candidateIdentity.updateMany.mockResolvedValue({ count: 1 });
});

describe("getCurrentInsight", () => {
  it("returns null when no insight exists", async () => {
    dbMocks.prisma.profileInsight.findFirst.mockResolvedValueOnce(null);
    const r = await getCurrentInsight("org-A", "ident-1");
    expect(r).toBeNull();
    expect(dbMocks.prisma.profileInsight.findFirst).toHaveBeenCalledWith({
      where: { orgId: "org-A", identityId: "ident-1", supersededAt: null },
      orderBy: { extractedAt: "desc" },
    });
  });

  it("scopes queries to orgId (multi-org isolation)", async () => {
    dbMocks.prisma.profileInsight.findFirst.mockResolvedValueOnce(null);
    await getCurrentInsight("org-B", "ident-1");
    const call = dbMocks.prisma.profileInsight.findFirst.mock.calls[0][0] as { where: { orgId: string } };
    expect(call.where.orgId).toBe("org-B");
  });

  it("parses factsJson into typed facts object", async () => {
    const now = new Date();
    dbMocks.prisma.profileInsight.findFirst.mockResolvedValueOnce({
      id: "pi-1",
      orgId: "org-A",
      identityId: "ident-1",
      factsJson: JSON.stringify(FACTS),
      extractionVersion: 1,
      promptVersion: "insight-v1.0",
      extractedBy: "claude",
      modelId: "claude-haiku-4-5-20251001",
      sourceProfileTextHash: "hash-A",
      sourceCandidateId: null,
      extractedAt: now,
      supersededAt: null,
    });
    const r = await getCurrentInsight("org-A", "ident-1");
    expect(r?.facts.currentTitle).toBe("Senior Engineer");
    expect(r?.facts.primaryStack).toEqual(["typescript", "react"]);
  });

  it("returns a thinProfile-shaped fallback when factsJson is corrupt (defensive)", async () => {
    dbMocks.prisma.profileInsight.findFirst.mockResolvedValueOnce({
      id: "pi-1",
      orgId: "org-A",
      identityId: "ident-1",
      factsJson: "{not-json",
      extractionVersion: 1,
      promptVersion: "insight-v1.0",
      extractedBy: "claude",
      modelId: "claude-haiku-4-5-20251001",
      sourceProfileTextHash: "hash-A",
      sourceCandidateId: null,
      extractedAt: new Date(),
      supersededAt: null,
    });
    const r = await getCurrentInsight("org-A", "ident-1");
    expect(r?.facts.thinProfile).toBe(true);
    expect(r?.facts.primaryStack).toEqual([]);
  });
});

describe("findInsightByKey", () => {
  it("queries by the unique tuple (orgId, identityId, hash, version)", async () => {
    dbMocks.prisma.profileInsight.findFirst.mockResolvedValueOnce(null);
    await findInsightByKey({
      orgId: "org-A",
      identityId: "ident-1",
      sourceProfileTextHash: "hash-A",
      extractionVersion: 1,
    });
    const call = dbMocks.prisma.profileInsight.findFirst.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(call.where).toEqual({
      orgId: "org-A",
      identityId: "ident-1",
      sourceProfileTextHash: "hash-A",
      extractionVersion: 1,
    });
  });
});

describe("saveInsight — idempotency", () => {
  it("returns the existing row without creating when (orgId, identityId, hash, version) already exists", async () => {
    const existing = {
      id: "pi-existing",
      orgId: "org-A",
      identityId: "ident-1",
      factsJson: JSON.stringify(FACTS),
      extractionVersion: 1,
      promptVersion: "insight-v1.0",
      extractedBy: "claude",
      modelId: "claude-haiku-4-5-20251001",
      sourceProfileTextHash: "hash-A",
      sourceCandidateId: null,
      extractedAt: new Date(),
      supersededAt: null,
    };
    dbMocks.prisma.profileInsight.findFirst.mockResolvedValueOnce(existing);
    const r = await saveInsight({
      orgId: "org-A",
      identityId: "ident-1",
      extracted: buildExtractedInsight(),
    });
    expect(r.id).toBe("pi-existing");
    // No transaction work happened.
    expect(dbMocks.prisma.profileInsight.create).not.toHaveBeenCalled();
    expect(dbMocks.prisma.profileInsight.updateMany).not.toHaveBeenCalled();
  });
});

describe("saveInsight — happy path / supersession", () => {
  it("creates a new row when no existing insight at the (hash, version) tuple", async () => {
    dbMocks.prisma.profileInsight.findFirst.mockResolvedValueOnce(null); // pre-check finds nothing
    const created = {
      id: "pi-new",
      orgId: "org-A",
      identityId: "ident-1",
      factsJson: JSON.stringify(FACTS),
      extractionVersion: 1,
      promptVersion: "insight-v1.0",
      extractedBy: "claude",
      modelId: "claude-haiku-4-5-20251001",
      sourceProfileTextHash: "hash-A",
      sourceCandidateId: null,
      extractedAt: new Date(),
      supersededAt: null,
    };
    dbMocks.prisma.profileInsight.create.mockResolvedValueOnce(created);
    const r = await saveInsight({
      orgId: "org-A",
      identityId: "ident-1",
      extracted: buildExtractedInsight({ sourceProfileTextHash: "hash-A" }),
    });
    expect(r.id).toBe("pi-new");

    // Supersession ran inside the transaction.
    expect(dbMocks.prisma.profileInsight.updateMany).toHaveBeenCalledWith({
      where: { orgId: "org-A", identityId: "ident-1", supersededAt: null },
      data: { supersededAt: expect.any(Date) },
    });
    // identity pointer updated.
    expect(dbMocks.prisma.candidateIdentity.updateMany).toHaveBeenCalledWith({
      where: { id: "ident-1", orgId: "org-A" },
      data: { currentInsightId: "pi-new" },
    });
  });

  it("supersedes the prior current row when a new hash lands for the same identity", async () => {
    // pre-check: no row for hash-B yet, but there's a current row for hash-A.
    dbMocks.prisma.profileInsight.findFirst.mockResolvedValueOnce(null);
    dbMocks.prisma.profileInsight.updateMany.mockResolvedValueOnce({ count: 1 });
    dbMocks.prisma.profileInsight.create.mockResolvedValueOnce({
      id: "pi-new-B",
      orgId: "org-A",
      identityId: "ident-1",
      factsJson: JSON.stringify(FACTS),
      extractionVersion: 1,
      promptVersion: "insight-v1.0",
      extractedBy: "claude",
      modelId: "claude-haiku-4-5-20251001",
      sourceProfileTextHash: "hash-B",
      sourceCandidateId: "cand-1",
      extractedAt: new Date(),
      supersededAt: null,
    });
    await saveInsight({
      orgId: "org-A",
      identityId: "ident-1",
      extracted: buildExtractedInsight({ sourceProfileTextHash: "hash-B" }),
      sourceCandidateId: "cand-1",
    });
    // The supersession updateMany must have been called once.
    expect(dbMocks.prisma.profileInsight.updateMany).toHaveBeenCalledTimes(1);
    // The create must record sourceCandidateId.
    const createCall = dbMocks.prisma.profileInsight.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(createCall.data.sourceCandidateId).toBe("cand-1");
    expect(createCall.data.sourceProfileTextHash).toBe("hash-B");
  });

  it("recovers from P2002 race by fetching the existing row", async () => {
    dbMocks.prisma.profileInsight.findFirst.mockResolvedValueOnce(null);
    const raceErr = Object.assign(new Error("Unique constraint violation"), { code: "P2002" });
    dbMocks.prisma.profileInsight.create.mockRejectedValueOnce(raceErr);
    const racedRow = {
      id: "pi-raced",
      orgId: "org-A",
      identityId: "ident-1",
      factsJson: JSON.stringify(FACTS),
      extractionVersion: 1,
      promptVersion: "insight-v1.0",
      extractedBy: "claude",
      modelId: "claude-haiku-4-5-20251001",
      sourceProfileTextHash: "hash-A",
      sourceCandidateId: null,
      extractedAt: new Date(),
      supersededAt: null,
    };
    dbMocks.prisma.profileInsight.findFirstOrThrow.mockResolvedValueOnce(racedRow);
    const r = await saveInsight({
      orgId: "org-A",
      identityId: "ident-1",
      extracted: buildExtractedInsight(),
    });
    expect(r.id).toBe("pi-raced");
    expect(dbMocks.prisma.profileInsight.findFirstOrThrow).toHaveBeenCalled();
  });

  it("re-throws non-P2002 errors instead of swallowing them", async () => {
    dbMocks.prisma.profileInsight.findFirst.mockResolvedValueOnce(null);
    dbMocks.prisma.profileInsight.create.mockRejectedValueOnce(new Error("disk full"));
    await expect(
      saveInsight({
        orgId: "org-A",
        identityId: "ident-1",
        extracted: buildExtractedInsight(),
      }),
    ).rejects.toThrow(/disk full/);
  });
});

describe("supersedeAllInsightsForIdentity", () => {
  it("marks all current insights superseded and clears currentInsightId", async () => {
    dbMocks.prisma.profileInsight.updateMany.mockResolvedValueOnce({ count: 2 });
    const count = await supersedeAllInsightsForIdentity({ orgId: "org-A", identityId: "ident-1" });
    expect(count).toBe(2);
    expect(dbMocks.prisma.profileInsight.updateMany).toHaveBeenCalledWith({
      where: { orgId: "org-A", identityId: "ident-1", supersededAt: null },
      data: { supersededAt: expect.any(Date) },
    });
    expect(dbMocks.prisma.candidateIdentity.updateMany).toHaveBeenCalledWith({
      where: { id: "ident-1", orgId: "org-A" },
      data: { currentInsightId: null },
    });
  });
});
