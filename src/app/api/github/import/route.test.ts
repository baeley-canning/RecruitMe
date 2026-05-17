import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    candidate: {
      create: vi.fn(),
      findFirst: vi.fn().mockResolvedValue(null),
    },
  },
}));

const aiMocks = vi.hoisted(() => ({
  scoreCandidateStructured: vi.fn(),
}));

const sessionMocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  requireJobAccess: vi.fn(),
  unauthorized: vi.fn(() => new Response(null, { status: 401 })),
}));

const scoringConfigMocks = vi.hoisted(() => ({
  weights: {
    must_have: 0.5,
    skill_fit: 0.2,
    location_fit: 0.05,
    seniority_fit: 0.05,
    title_fit: 0.05,
    domain_fit: 0.1,
    nice_to_have_fit: 0.05,
  },
  getJobScoringWeights: vi.fn(),
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/ai", () => aiMocks);
vi.mock("@/lib/session", () => sessionMocks);
vi.mock("@/lib/scoring-config", () => ({
  getJobScoringWeights: scoringConfigMocks.getJobScoringWeights,
}));

import { POST } from "./route";

const VALID_BODY = {
  jobId: "job-1",
  login: "alex",
  name: "Alex Chen",
  headline: "Engineer",
  location: "Wellington",
  githubUrl: "https://github.com/alex",
  profileText: "Alex Chen — Full-stack engineer with 8 years experience building Ruby on Rails and React production applications. Strong TypeScript and AWS background. Based in Wellington.",
};

describe("github import route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const job = {
      id: "job-1",
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
      salaryMin: null,
      salaryMax: null,
      location: "Wellington",
      isRemote: false,
      scoringWeights: null,
    };
    sessionMocks.getAuth.mockResolvedValue({ userId: "user-1", orgId: "org-1" });
    sessionMocks.requireJobAccess.mockResolvedValue({ job, error: null });
    scoringConfigMocks.getJobScoringWeights.mockResolvedValue(scoringConfigMocks.weights);
    dbMocks.prisma.candidate.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "cand-new",
      ...data,
    }));
  });

  it("flags scoringError on screeningData when scoring fails (does not silently drop the score)", async () => {
    // Before the fix: a bare `catch {}` swallowed scoring errors completely
    // — the candidate landed with no score AND no failure trail, so the
    // recruiter couldn't tell "import worked, scoring blew up" from "import
    // worked, JD not parsed yet". After the fix the candidate row carries
    // screeningData.scoringError so the failure is visible.
    aiMocks.scoreCandidateStructured.mockRejectedValueOnce(new Error("Claude 503"));

    const req = new Request("http://localhost/api/github/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    expect(dbMocks.prisma.candidate.create).toHaveBeenCalledTimes(1);
    const createData = dbMocks.prisma.candidate.create.mock.calls[0][0].data as Record<string, unknown>;
    // No matchScore set (scoring never produced one)…
    expect(createData.matchScore).toBeUndefined();
    // …but the row carries an explicit scoringError flag.
    expect(typeof createData.screeningData).toBe("string");
    const screening = JSON.parse(createData.screeningData as string);
    expect(screening.scoringError).toContain("Claude 503");
    expect(screening.scoringErrorAt).toBeTruthy();
  });

  it("happy path: scores cleanly and persists the breakdown without scoringError", async () => {
    aiMocks.scoreCandidateStructured.mockResolvedValueOnce({
      version: 2,
      overall: 75,
      categories: {
        skill_fit:        { score: 80, weight: 0.2,  evidence: "x" },
        location_fit:     { score: 100, weight: 0.05, evidence: "x" },
        seniority_fit:    { score: 70, weight: 0.05, evidence: "x" },
        title_fit:        { score: 70, weight: 0.05, evidence: "x" },
        domain_fit:       { score: 65, weight: 0.1,  evidence: "x" },
        nice_to_have_fit: { score: 50, weight: 0.05, evidence: "x" },
      },
      must_have_coverage: [{ requirement: "React", status: "confirmed", evidence: "Listed." }],
      nice_to_have_coverage: [],
      reasons_for: ["Strong fit."],
      reasons_against: [],
      missing_evidence: [],
      recruiter_summary: "Solid.",
    });

    const req = new Request("http://localhost/api/github/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    const createData = dbMocks.prisma.candidate.create.mock.calls[0][0].data as Record<string, unknown>;
    expect(createData.matchScore).toBe(75);
    // Happy path leaves screeningData untouched.
    expect(createData.screeningData).toBeUndefined();
  });
});
