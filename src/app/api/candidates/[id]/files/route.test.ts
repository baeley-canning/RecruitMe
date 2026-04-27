import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildScoreBreakdown, CATEGORY_WEIGHTS_V2 } from "@/lib/scoring";
import { buildScoreCacheKey } from "@/lib/utils";

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

const dbMocks = vi.hoisted(() => ({
  prisma: {
    candidate: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    candidateFile: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

const sessionMocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  unauthorized: vi.fn(() => new Response(null, { status: 401 })),
}));

const aiMocks = vi.hoisted(() => ({
  scoreCandidateStructured: vi.fn(),
  predictAcceptance: vi.fn().mockResolvedValue({
    score: 64,
    likelihood: "medium",
    headline: "May consider",
    signals: [],
    summary: "Could be open to a relevant role.",
  }),
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/session", () => sessionMocks);
vi.mock("@/lib/ai", () => aiMocks);

import { POST } from "./route";

const cvText = "Jane Candidate\nSoftware Engineer\n".repeat(8);

function makeCandidate() {
  return {
    id: "cand-1",
    source: "manual",
    location: "Wellington, New Zealand",
    job: {
      orgId: "org-1",
      parsedRole: JSON.stringify({
        title: "Software Engineer",
        location: "Wellington",
        location_rules: "Wellington office",
        must_haves: ["React"],
        nice_to_haves: [],
        knockout_criteria: [],
        skills_required: ["React"],
        skills_preferred: [],
      }),
      salaryMin: 90000,
      salaryMax: 120000,
      isRemote: false,
      location: "Wellington",
    },
  };
}

function makeBreakdown() {
  return buildScoreBreakdown({
    categories: {
      skill_fit: { score: 80, weight: CATEGORY_WEIGHTS_V2.skill_fit, evidence: "React confirmed." },
      location_fit: { score: 100, weight: CATEGORY_WEIGHTS_V2.location_fit, evidence: "Location fits." },
      seniority_fit: { score: 70, weight: CATEGORY_WEIGHTS_V2.seniority_fit, evidence: "Seniority fits." },
      title_fit: { score: 70, weight: CATEGORY_WEIGHTS_V2.title_fit, evidence: "Title fits." },
      industry_fit: { score: 55, weight: CATEGORY_WEIGHTS_V2.industry_fit, evidence: "Some overlap." },
      nice_to_have_fit: { score: 50, weight: CATEGORY_WEIGHTS_V2.nice_to_have_fit, evidence: "Neutral." },
      keyword_alignment: { score: 70, weight: CATEGORY_WEIGHTS_V2.keyword_alignment, evidence: "Aligned." },
    },
    must_have_coverage: [{ requirement: "React", status: "confirmed", evidence: "Listed." }],
    nice_to_have_coverage: [],
    reasons_for: ["Good fit."],
    reasons_against: [],
    missing_evidence: [],
    recruiter_summary: "Good candidate.",
    profileCharCount: cvText.length,
  });
}

function makeRequest() {
  const formData = new FormData();
  formData.append("type", "cv");
  formData.append("file", new File([cvText], "cv.txt", { type: "text/plain" }));
  return new Request("http://localhost/api/candidates/cand-1/files", {
    method: "POST",
    body: formData,
  });
}

describe("candidate file CV upload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionMocks.getAuth.mockResolvedValue({ userId: "user-1", orgId: "org-1", isOwner: false });
    dbMocks.prisma.candidate.findUnique.mockResolvedValue(makeCandidate());
    dbMocks.prisma.candidateFile.create.mockResolvedValue({
      id: "file-1",
      type: "cv",
      filename: "cv.txt",
      mimeType: "text/plain",
      size: cvText.length,
      createdAt: new Date(),
    });
    dbMocks.prisma.candidate.update.mockResolvedValue({ id: "cand-1" });
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy?.mockRestore();
  });

  it("clears stale score fields when CV scoring fails", async () => {
    aiMocks.scoreCandidateStructured.mockRejectedValue(new Error("model unavailable"));

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "cand-1" }) });

    expect(res.status).toBe(201);
    expect(dbMocks.prisma.candidate.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "cand-1" },
      data: expect.objectContaining({
        profileText: cvText.trim(),
        profileTextHash: null,
        matchScore: null,
        matchReason: null,
        scoreBreakdown: null,
        acceptanceScore: null,
        acceptanceReason: null,
      }),
    }));
  });

  it("stores a score-context cache key only after successful CV scoring", async () => {
    const candidate = makeCandidate();
    const parsedRole = JSON.parse(candidate.job.parsedRole);
    aiMocks.scoreCandidateStructured.mockResolvedValue(makeBreakdown());

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "cand-1" }) });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.scored).toBe(true);
    expect(dbMocks.prisma.candidate.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        profileTextHash: buildScoreCacheKey({
          profileText: cvText.trim(),
          parsedRole,
          salary: { min: 90000, max: 120000 },
          jobLocation: "Wellington",
          isRemote: false,
        }),
        scoreBreakdown: expect.stringContaining("\"version\":2"),
      }),
    }));
  });
});
