import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    candidate: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

const aiMocks = vi.hoisted(() => ({
  scoreCandidateStructured: vi.fn(),
}));

const sessionMocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  unauthorized: vi.fn(() => new Response(null, { status: 401 })),
}));

const scoringConfigMocks = vi.hoisted(() => ({
  getJobScoringWeights: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/ai", () => aiMocks);
vi.mock("@/lib/session", () => sessionMocks);
vi.mock("@/lib/scoring-config", () => scoringConfigMocks);

import { PATCH } from "./route";
import { buildScoreBreakdown, CATEGORY_WEIGHTS_V2 } from "@/lib/scoring";

function makeBreakdown(overall: number) {
  return buildScoreBreakdown({
    categories: {
      skill_fit: { score: overall, weight: CATEGORY_WEIGHTS_V2.skill_fit, evidence: "" },
      location_fit: { score: 100, weight: CATEGORY_WEIGHTS_V2.location_fit, evidence: "" },
      seniority_fit: { score: 70, weight: CATEGORY_WEIGHTS_V2.seniority_fit, evidence: "" },
      title_fit: { score: 70, weight: CATEGORY_WEIGHTS_V2.title_fit, evidence: "" },
      domain_fit: { score: 70, weight: CATEGORY_WEIGHTS_V2.domain_fit, evidence: "" },
      nice_to_have_fit: { score: 50, weight: CATEGORY_WEIGHTS_V2.nice_to_have_fit, evidence: "" },
    },
    must_have_coverage: [{ requirement: "C++", status: "confirmed", evidence: "C++ Developer at NZ Customs (1997 - 1998)" }],
    nice_to_have_coverage: [],
    reasons_for: [], reasons_against: [], missing_evidence: [],
    recruiter_summary: "",
    profileCharCount: 5000,
    claudeOverallScore: overall,
  });
}

const baseCandidate = {
  id: "cand-1",
  orgId: "org-1",
  profileText: "Headline + About text only.",
  location: "Wellington, New Zealand",
  job: {
    id: "job-1",
    title: "Senior Dev",
    company: "Co",
    location: "Wellington",
    isRemote: false,
    salaryMin: null, salaryMax: null,
    parsedRole: JSON.stringify({
      title: "Senior Dev",
      location: "Wellington",
      must_haves: ["C++"],
      skills_required: ["C++"],
    }),
    scoringWeights: null,
    orgId: "org-1",
  },
};

describe("PATCH /api/candidates/[id]/profile-text", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionMocks.getAuth.mockResolvedValue({ userId: "u-1", orgId: "org-1", isOwner: false });
    dbMocks.prisma.candidate.findUnique.mockResolvedValue(baseCandidate);
    dbMocks.prisma.$transaction.mockImplementation(async (fn: (tx: typeof dbMocks.prisma) => Promise<unknown>) =>
      fn(dbMocks.prisma)
    );
    dbMocks.prisma.candidate.update.mockResolvedValue({ ...baseCandidate, profileText: "merged" });
    aiMocks.scoreCandidateStructured.mockResolvedValue(makeBreakdown(78));
  });

  it("rejects whitespace-only text with 422", async () => {
    const req = new Request("http://localhost/api/candidates/cand-1/profile-text", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "   \n   ", mode: "append" }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: "cand-1" }) });
    expect(res.status).toBe(422);
  });

  it("rejects unauthenticated requests with 401", async () => {
    sessionMocks.getAuth.mockResolvedValue(null);
    const req = new Request("http://localhost/api/candidates/cand-1/profile-text", {
      method: "PATCH",
      body: JSON.stringify({ text: "x", mode: "append" }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: "cand-1" }) });
    expect(res.status).toBe(401);
  });

  it("rejects cross-org access with 403", async () => {
    sessionMocks.getAuth.mockResolvedValue({ userId: "u-2", orgId: "org-2", isOwner: false });
    const req = new Request("http://localhost/api/candidates/cand-1/profile-text", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "C++ at NZ Customs", mode: "append" }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: "cand-1" }) });
    expect(res.status).toBe(403);
  });

  it("appends text with separator on append mode and triggers re-score", async () => {
    const req = new Request("http://localhost/api/candidates/cand-1/profile-text", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "C++ Developer at NZ Customs (1997 - 1998). Sybase ASE at Xacta/ACC (1998 - 2001).",
        mode: "append",
      }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: "cand-1" }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.scored).toBe(true);
    expect(body.matchScore).toBe(78);
    // Transaction was used for race-safety
    expect(dbMocks.prisma.$transaction).toHaveBeenCalledTimes(1);
    // scoreCandidateStructured received text containing the new content
    const scoredText = aiMocks.scoreCandidateStructured.mock.calls[0][0] as string;
    expect(scoredText).toContain("C++ Developer at NZ Customs");
  });

  it("replace mode wipes existing profileText", async () => {
    dbMocks.prisma.candidate.update.mockImplementationOnce(async (args: { data: { profileText: string } }) => {
      expect(args.data.profileText).toBe("Brand new text");
      return baseCandidate;
    });
    const req = new Request("http://localhost/api/candidates/cand-1/profile-text", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Brand new text", mode: "replace" }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: "cand-1" }) });
    expect(res.status).toBe(200);
  });

  it("survives Claude scoring failure — saves text but reports scored=false", async () => {
    aiMocks.scoreCandidateStructured.mockRejectedValueOnce(new Error("model offline"));
    const req = new Request("http://localhost/api/candidates/cand-1/profile-text", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Some pasted history", mode: "append" }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: "cand-1" }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.scored).toBe(false);
    expect(body.matchScore).toBe(null);
  });

  it("library-only candidate (no job) skips re-score gracefully", async () => {
    dbMocks.prisma.candidate.findUnique.mockResolvedValue({ ...baseCandidate, job: null });
    const req = new Request("http://localhost/api/candidates/cand-1/profile-text", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Some text", mode: "append" }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: "cand-1" }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.scored).toBe(false);
    // scoreCandidateStructured should not have been called
    expect(aiMocks.scoreCandidateStructured).not.toHaveBeenCalled();
  });

  it("owner bypasses org check", async () => {
    sessionMocks.getAuth.mockResolvedValue({ userId: "owner", orgId: "different-org", isOwner: true });
    const req = new Request("http://localhost/api/candidates/cand-1/profile-text", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Owner override", mode: "append" }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: "cand-1" }) });
    expect(res.status).toBe(200);
  });
});
