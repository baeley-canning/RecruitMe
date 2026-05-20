/**
 * Tests for POST /api/admin/insights/extract.
 *
 * Covers:
 *   • Feature flag OFF returns 404 (no work done)
 *   • Auth: cron secret valid → proceeds
 *   • Auth: owner session valid → proceeds
 *   • Auth: neither → 403
 *   • Body validation: missing identityId → 422
 *   • Identity not found → 404
 *   • Identity with no profileText on any candidate → returns
 *     { action: "skipped", reason: "no_profile_text" }
 *   • Happy path → extractInsight + saveInsight called with the longest
 *     candidate's sanitised profileText; returns the saved row metadata
 *   • Sanitiser drop count surfaced in the response
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    candidateIdentity: { findUnique: vi.fn() },
  },
}));

const aiMocks = vi.hoisted(() => ({
  extractInsight: vi.fn(),
}));

const cacheMocks = vi.hoisted(() => ({
  saveInsight: vi.fn(),
}));

const sanitiserMocks = vi.hoisted(() => ({
  sanitiseProfileTextForInsight: vi.fn((text: string) => ({
    sanitised: text.replace(/Internal note:.*$/im, ""),
    droppedLines: text.includes("Internal note:") ? 1 : 0,
    totalLines: text.split("\n").length,
  })),
}));

const sessionMocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/ai/insights", async () => {
  // Re-export the real INSIGHT constants but mock extractInsight.
  const actual = await vi.importActual<typeof import("@/lib/ai/insights")>("@/lib/ai/insights");
  return { ...actual, extractInsight: aiMocks.extractInsight };
});
vi.mock("@/lib/insight-cache", () => cacheMocks);
vi.mock("@/lib/profile-text-sanitiser", () => sanitiserMocks);
vi.mock("@/lib/session", () => ({
  ...sessionMocks,
  unauthorized: vi.fn(() => new Response(null, { status: 401 })),
}));

import { POST } from "@/app/api/admin/insights/extract/route";

beforeEach(() => {
  vi.resetAllMocks();
  process.env.RECRUITME_PROFILE_INSIGHT_WRITE_ENABLED = "true";
  process.env.CONTACT_SYNC_CRON_SECRET = "test-secret-xyz";
  sanitiserMocks.sanitiseProfileTextForInsight.mockImplementation((text: string) => ({
    sanitised: text,
    droppedLines: 0,
    totalLines: text.split("\n").length,
  }));
});

afterEach(() => {
  delete process.env.RECRUITME_PROFILE_INSIGHT_WRITE_ENABLED;
  delete process.env.CONTACT_SYNC_CRON_SECRET;
});

function makeReq(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://test/api/admin/insights/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/admin/insights/extract — feature flag", () => {
  it("returns 404 when the write flag is OFF (default in non-rollout envs)", async () => {
    process.env.RECRUITME_PROFILE_INSIGHT_WRITE_ENABLED = "false";
    const res = await POST(makeReq({ identityId: "i-1" }, { "x-cron-secret": "test-secret-xyz" }));
    expect(res.status).toBe(404);
    expect(dbMocks.prisma.candidateIdentity.findUnique).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/insights/extract — auth", () => {
  it("403 when no cron secret AND no owner session", async () => {
    sessionMocks.getAuth.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ identityId: "i-1" }));
    expect(res.status).toBe(403);
  });

  it("403 when wrong cron secret is presented and no valid session", async () => {
    sessionMocks.getAuth.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ identityId: "i-1" }, { "x-cron-secret": "wrong-secret" }));
    expect(res.status).toBe(403);
    // Wrong secret falls through to session check (defense in depth) — that's by design.
    expect(sessionMocks.getAuth).toHaveBeenCalled();
  });

  it("403 when owner session is missing isOwner=true", async () => {
    sessionMocks.getAuth.mockResolvedValueOnce({ userId: "u1", orgId: "org-A", isOwner: false });
    const res = await POST(makeReq({ identityId: "i-1" }));
    expect(res.status).toBe(403);
  });

  it("proceeds when cron secret matches", async () => {
    dbMocks.prisma.candidateIdentity.findUnique.mockResolvedValueOnce({
      id: "i-1",
      orgId: "org-A",
      candidates: [{ id: "c-1", profileText: "a".repeat(800) }],
    });
    aiMocks.extractInsight.mockResolvedValueOnce({
      facts: { primaryStack: [], thinProfile: false } as never,
      extractedBy: "claude",
      modelId: "claude-haiku-4-5-20251001",
      sourceProfileTextHash: "hash-A",
      promptVersion: "insight-v1.0",
      extractionVersion: 1,
    });
    cacheMocks.saveInsight.mockResolvedValueOnce({
      id: "pi-1",
      orgId: "org-A",
      identityId: "i-1",
      facts: { primaryStack: [], thinProfile: false } as never,
      extractionVersion: 1,
      promptVersion: "insight-v1.0",
      extractedBy: "claude",
      modelId: "claude-haiku-4-5-20251001",
      sourceProfileTextHash: "hash-A",
      sourceCandidateId: "c-1",
      extractedAt: new Date(),
      supersededAt: null,
    });
    const res = await POST(makeReq({ identityId: "i-1" }, { "x-cron-secret": "test-secret-xyz" }));
    expect(res.status).toBe(200);
    expect(sessionMocks.getAuth).not.toHaveBeenCalled(); // cron path bypasses session
  });

  it("proceeds when authenticated owner with no cron secret", async () => {
    sessionMocks.getAuth.mockResolvedValueOnce({ userId: "u1", orgId: null, isOwner: true });
    dbMocks.prisma.candidateIdentity.findUnique.mockResolvedValueOnce({
      id: "i-1",
      orgId: "org-A",
      candidates: [{ id: "c-1", profileText: "a".repeat(800) }],
    });
    aiMocks.extractInsight.mockResolvedValueOnce({
      facts: { primaryStack: [] } as never,
      extractedBy: "claude",
      modelId: "claude-haiku-4-5-20251001",
      sourceProfileTextHash: "hash-A",
      promptVersion: "insight-v1.0",
      extractionVersion: 1,
    });
    cacheMocks.saveInsight.mockResolvedValueOnce({
      id: "pi-1",
      orgId: "org-A",
      identityId: "i-1",
      facts: {} as never,
      extractionVersion: 1,
      promptVersion: "insight-v1.0",
      extractedBy: "claude",
      modelId: "claude-haiku-4-5-20251001",
      sourceProfileTextHash: "hash-A",
      sourceCandidateId: "c-1",
      extractedAt: new Date(),
      supersededAt: null,
    });
    const res = await POST(makeReq({ identityId: "i-1" }));
    expect(res.status).toBe(200);
  });
});

describe("POST /api/admin/insights/extract — body validation", () => {
  it("422 when identityId missing", async () => {
    const res = await POST(makeReq({}, { "x-cron-secret": "test-secret-xyz" }));
    expect(res.status).toBe(422);
  });

  it("422 when identityId is not a string", async () => {
    const res = await POST(makeReq({ identityId: 123 }, { "x-cron-secret": "test-secret-xyz" }));
    expect(res.status).toBe(422);
  });
});

describe("POST /api/admin/insights/extract — identity lookup", () => {
  it("404 when identity not found", async () => {
    dbMocks.prisma.candidateIdentity.findUnique.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ identityId: "i-missing" }, { "x-cron-secret": "test-secret-xyz" }));
    expect(res.status).toBe(404);
  });

  it("returns skipped when identity has no candidate profileText", async () => {
    dbMocks.prisma.candidateIdentity.findUnique.mockResolvedValueOnce({
      id: "i-1",
      orgId: "org-A",
      candidates: [],
    });
    const res = await POST(makeReq({ identityId: "i-1" }, { "x-cron-secret": "test-secret-xyz" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.action).toBe("skipped");
    expect(body.reason).toBe("no_profile_text");
    expect(aiMocks.extractInsight).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/insights/extract — happy path", () => {
  it("picks the LONGEST profileText across the identity's candidates", async () => {
    dbMocks.prisma.candidateIdentity.findUnique.mockResolvedValueOnce({
      id: "i-1",
      orgId: "org-A",
      candidates: [
        { id: "c-short", profileText: "short" },
        { id: "c-long", profileText: "x".repeat(1500) },
        { id: "c-medium", profileText: "y".repeat(800) },
      ],
    });
    aiMocks.extractInsight.mockResolvedValueOnce({
      facts: { primaryStack: ["typescript"], thinProfile: false } as never,
      extractedBy: "claude",
      modelId: "claude-haiku-4-5-20251001",
      sourceProfileTextHash: "hash-A",
      promptVersion: "insight-v1.0",
      extractionVersion: 1,
    });
    cacheMocks.saveInsight.mockResolvedValueOnce({
      id: "pi-1",
      orgId: "org-A",
      identityId: "i-1",
      facts: {} as never,
      extractionVersion: 1,
      promptVersion: "insight-v1.0",
      extractedBy: "claude",
      modelId: "claude-haiku-4-5-20251001",
      sourceProfileTextHash: "hash-A",
      sourceCandidateId: "c-long",
      extractedAt: new Date(),
      supersededAt: null,
    });

    const res = await POST(makeReq({ identityId: "i-1" }, { "x-cron-secret": "test-secret-xyz" }));
    expect(res.status).toBe(200);

    // extractInsight should have received the longest text (sanitised).
    const extractArg = aiMocks.extractInsight.mock.calls[0][0] as { profileText: string };
    expect(extractArg.profileText.length).toBe(1500);

    // saveInsight should have been called with sourceCandidateId = c-long.
    const saveArg = cacheMocks.saveInsight.mock.calls[0][0] as { sourceCandidateId: string };
    expect(saveArg.sourceCandidateId).toBe("c-long");
  });

  it("surfaces sanitiser drop count in the response", async () => {
    const dirtyText = "WORK EXPERIENCE\nSenior Engineer at Acme\n".repeat(20) + "Internal note: ignore this";
    dbMocks.prisma.candidateIdentity.findUnique.mockResolvedValueOnce({
      id: "i-1",
      orgId: "org-A",
      candidates: [{ id: "c-1", profileText: dirtyText }],
    });
    sanitiserMocks.sanitiseProfileTextForInsight.mockImplementationOnce((text: string) => ({
      sanitised: text.replace(/Internal note:.*$/im, ""),
      droppedLines: 1,
      totalLines: text.split("\n").length,
    }));
    aiMocks.extractInsight.mockResolvedValueOnce({
      facts: {} as never,
      extractedBy: "claude",
      modelId: "claude-haiku-4-5-20251001",
      sourceProfileTextHash: "hash-A",
      promptVersion: "insight-v1.0",
      extractionVersion: 1,
    });
    cacheMocks.saveInsight.mockResolvedValueOnce({
      id: "pi-1",
      orgId: "org-A",
      identityId: "i-1",
      facts: {} as never,
      extractionVersion: 1,
      promptVersion: "insight-v1.0",
      extractedBy: "claude",
      modelId: "claude-haiku-4-5-20251001",
      sourceProfileTextHash: "hash-A",
      sourceCandidateId: "c-1",
      extractedAt: new Date(),
      supersededAt: null,
    });

    const res = await POST(makeReq({ identityId: "i-1" }, { "x-cron-secret": "test-secret-xyz" }));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.sanitisationDroppedLines).toBe(1);
  });

  it("returns the saved insight row's provenance + version", async () => {
    dbMocks.prisma.candidateIdentity.findUnique.mockResolvedValueOnce({
      id: "i-1",
      orgId: "org-A",
      candidates: [{ id: "c-1", profileText: "z".repeat(900) }],
    });
    aiMocks.extractInsight.mockResolvedValueOnce({
      facts: { primaryStack: ["go"] } as never,
      extractedBy: "openai", // failover
      modelId: "gpt-4o-mini",
      sourceProfileTextHash: "hash-A",
      promptVersion: "insight-v1.0",
      extractionVersion: 1,
    });
    cacheMocks.saveInsight.mockResolvedValueOnce({
      id: "pi-1",
      orgId: "org-A",
      identityId: "i-1",
      facts: {} as never,
      extractionVersion: 1,
      promptVersion: "insight-v1.0",
      extractedBy: "openai",
      modelId: "gpt-4o-mini",
      sourceProfileTextHash: "hash-A",
      sourceCandidateId: "c-1",
      extractedAt: new Date(),
      supersededAt: null,
    });

    const res = await POST(makeReq({ identityId: "i-1" }, { "x-cron-secret": "test-secret-xyz" }));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.action).toBe("extracted");
    expect(body.extractedBy).toBe("openai");
    expect(body.modelId).toBe("gpt-4o-mini");
    expect(body.extractionVersion).toBe(1);
    expect(body.insightId).toBe("pi-1");
  });
});
