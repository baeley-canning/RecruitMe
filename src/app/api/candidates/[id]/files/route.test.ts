import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
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
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
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
  cleanCvText: vi.fn().mockImplementation((s: string) => Promise.resolve(s)),
  extractCandidateInfo: vi.fn().mockResolvedValue({ name: "", headline: "", location: "" }),
}));

const linkedinCaptureMocks = vi.hoisted(() => ({
  extractIdentityFromLinkedInProfileText: vi.fn(() => ({ name: null, headline: null, location: null })),
}));

const scoringConfigMocks = vi.hoisted(() => ({
  customWeights: {
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
vi.mock("@/lib/session", () => sessionMocks);
vi.mock("@/lib/ai", () => aiMocks);
vi.mock("@/lib/scoring-config", () => ({
  getJobScoringWeights: scoringConfigMocks.getJobScoringWeights,
}));
vi.mock("@/lib/linkedin-capture", () => linkedinCaptureMocks);
vi.mock("@/lib/pdf", () => ({
  extractTextFromPdf: vi.fn().mockResolvedValue(""),
}));
// Encryption is unit-tested in src/lib/__tests__/cv-encryption.test.ts; here we
// stub it so the route test focuses on the upload flow and doesn't need a key
// or DB-backed Setting bootstrap.
vi.mock("@/lib/cv-encryption", () => ({
  encryptCv: vi.fn(async (plain: string) => `v1:enc(${plain.slice(0, 12)})`),
  decryptCv: vi.fn(async (stored: string) => stored),
  isEncrypted: (s: string) => s.startsWith("v1:"),
  maybeMigrateLegacy: vi.fn().mockResolvedValue(undefined),
}));

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
      domain_fit: { score: 62, weight: CATEGORY_WEIGHTS_V2.domain_fit, evidence: "Some domain overlap, aligned wording." },
      nice_to_have_fit: { score: 50, weight: CATEGORY_WEIGHTS_V2.nice_to_have_fit, evidence: "Neutral." },
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
    scoringConfigMocks.getJobScoringWeights.mockResolvedValue(scoringConfigMocks.customWeights);
    dbMocks.prisma.candidate.findUnique.mockResolvedValue(makeCandidate());
    // Default: no prior files exist on the candidate, so the dup-detection
    // check in route.ts (added to prevent silent CV reuploads from clobbering
    // extracted fields) finds nothing and lets the upload proceed.
    dbMocks.prisma.candidateFile.findMany.mockResolvedValue([]);
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
    expect(aiMocks.scoreCandidateStructured).toHaveBeenCalledWith(
      cvText.trim(),
      parsedRole,
      { min: 90000, max: 120000 },
      scoringConfigMocks.customWeights,
      "org-1"
    );
    expect(dbMocks.prisma.candidate.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        profileTextHash: buildScoreCacheKey({
          profileText: cvText.trim(),
          parsedRole,
          salary: { min: 90000, max: 120000 },
          jobLocation: "Wellington",
          isRemote: false,
          weights: scoringConfigMocks.customWeights,
        }),
        scoreBreakdown: expect.stringContaining("\"version\":2"),
      }),
    }));
  });

  it("returns the existing row instead of 500 when a concurrent uploader wins the race on the unique (candidateId, dataHash) index", async () => {
    aiMocks.scoreCandidateStructured.mockResolvedValue(makeBreakdown());
    const existingRow = {
      id: "file-existing",
      type: "cv",
      filename: "cv.txt",
      mimeType: "text/plain",
      size: cvText.length,
      createdAt: new Date(),
    };
    // First findFirst is the fast-path dup check (returns null — race not yet
    // visible). After the unique-constraint violation we look up the winner.
    dbMocks.prisma.candidateFile.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existingRow);
    const p2002 = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed on the fields: (`candidateId`,`dataHash`)",
      { code: "P2002", clientVersion: "5.0.0" },
    );
    dbMocks.prisma.candidateFile.create.mockRejectedValueOnce(p2002);

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "cand-1" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual(expect.objectContaining({
      id: "file-existing",
      duplicate: true,
    }));
  });

  it("still returns the saved file when CV post-processing fails after upload", async () => {
    aiMocks.scoreCandidateStructured.mockResolvedValue(makeBreakdown());
    dbMocks.prisma.candidate.update.mockRejectedValueOnce(new Error("profileText column write failed"));

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "cand-1" }) });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body).toEqual(expect.objectContaining({
      id: "file-1",
      filename: "cv.txt",
      scored: false,
      processingError: expect.stringContaining("CV uploaded"),
    }));
    expect(dbMocks.prisma.candidateFile.create).toHaveBeenCalled();
  });
});
