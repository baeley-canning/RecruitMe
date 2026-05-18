import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildScoreBreakdown, CATEGORY_WEIGHTS_V2, type ScoreBreakdown } from "../scoring";
import type { ParsedRole } from "../ai";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    candidate: {
      findMany: vi.fn(),
    },
  },
}));

const aiMocks = vi.hoisted(() => ({
  scoreCandidateStructured: vi.fn(),
}));

vi.mock("../db", () => dbMocks);
vi.mock("../ai", async () => {
  const actual = await vi.importActual<typeof import("../ai")>("../ai");
  return { ...actual, scoreCandidateStructured: aiMocks.scoreCandidateStructured };
});

import { searchTalentPoolForRole, POOL_SEARCH_DEFAULT_SHORTLIST } from "../talent-pool";
import { normaliseLinkedInUrl } from "../linkedin";

function makeRole(overrides: Partial<ParsedRole>): ParsedRole {
  return {
    title: "Software Engineer",
    title_source: "explicit",
    company: "",
    company_source: "explicit",
    location: "Wellington",
    location_source: "explicit",
    experience: "",
    seniority_band: "senior",
    seniority_source: "explicit",
    salary_band: "",
    salary_source: "inferred",
    location_rules: "Wellington office",
    location_rules_source: "explicit",
    visa_flags: [],
    must_haves: [],
    nice_to_haves: [],
    knockout_criteria: [],
    application_requirements: [],
    explicitly_stated: [],
    strongly_inferred: [],
    search_expansion: [],
    synonym_titles: [],
    responsibilities: [],
    search_queries: [],
    google_queries: [],
    skills_required: [],
    skills_preferred: [],
    skill_notes: [],
    dismissed_skill_notes: [],
    dismissed_knockout_criteria: [],
    promoted_visa_flags: [],
    anchor_terms: [],
    ...overrides,
  } as ParsedRole;
}

function makeBreakdown(overall: number): ScoreBreakdown {
  return buildScoreBreakdown({
    categories: {
      skill_fit:        { score: 80, weight: CATEGORY_WEIGHTS_V2.skill_fit, evidence: "" },
      location_fit:     { score: 100, weight: CATEGORY_WEIGHTS_V2.location_fit, evidence: "" },
      seniority_fit:    { score: 80, weight: CATEGORY_WEIGHTS_V2.seniority_fit, evidence: "" },
      title_fit:        { score: 80, weight: CATEGORY_WEIGHTS_V2.title_fit, evidence: "" },
      domain_fit:       { score: 70, weight: CATEGORY_WEIGHTS_V2.domain_fit, evidence: "" },
      nice_to_have_fit: { score: 50, weight: CATEGORY_WEIGHTS_V2.nice_to_have_fit, evidence: "" },
    },
    must_have_coverage: [{ requirement: "test", status: "confirmed", evidence: "" }],
    nice_to_have_coverage: [],
    reasons_for: [],
    reasons_against: [],
    missing_evidence: [],
    recruiter_summary: "",
    profileCharCount: 3000,
    claudeOverallScore: overall,
  });
}

const longProfile = (extra = "") =>
  "Lorem ipsum profile text full of detail about engineering experience. ".repeat(40) + extra;

const POWER_ROLE = makeRole({
  title: "SCADA Engineer (POWER)",
  must_haves: ["SCADA systems experience", "RTU configuration", "Smart metering"],
  skills_required: ["SCADA", "RTU", "metering"],
});

const CPP_SYBASE_ROLE = makeRole({
  title: "Senior C++ Developer",
  must_haves: ["C++ programming experience", "Sybase database experience"],
  skills_required: ["C++", "Sybase"],
});

describe("searchTalentPoolForRole", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    aiMocks.scoreCandidateStructured.mockResolvedValue(makeBreakdown(72));
  });

  it("dedupes the same person across multiple jobs by linkedinUrl (most recent capture wins)", async () => {
    const olderDate = new Date("2025-01-01");
    const newerDate = new Date("2025-12-01");
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      {
        id: "row-old",
        name: "Sam Engineer",
        headline: "SCADA Engineer at Mercury",
        location: "Christchurch, New Zealand",
        linkedinUrl: "https://www.linkedin.com/in/sam-engineer/",
        profileText: longProfile("SCADA RTU metering"),
        profileCapturedAt: olderDate,
        createdAt: olderDate,
      },
      {
        id: "row-new",
        name: "Sam Engineer",
        headline: "Senior SCADA Engineer at Mercury",
        location: "Christchurch, New Zealand",
        linkedinUrl: "https://www.linkedin.com/in/sam-engineer/",
        profileText: longProfile("SCADA RTU metering"),
        profileCapturedAt: newerDate,
        createdAt: newerDate,
      },
    ]);

    const summary = await searchTalentPoolForRole({
      parsedRole: POWER_ROLE,
      job: { isRemote: false },
      orgScope: "org-1",
      excludeLinkedInUrls: new Set(),
      maxResults: 5,
      targetLocation: "Christchurch, New Zealand",
      scoringOrgId: "org-1",
      salary: null,
    });

    // Only ONE result for the deduped person, scored against the new role.
    expect(summary.preRankPool).toBe(1);
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0].hit.candidateId).toBe("row-new");
    // Claude was called once (one unique candidate), proving stale matchScore
    // wasn't blindly reused.
    expect(aiMocks.scoreCandidateStructured).toHaveBeenCalledTimes(1);
  });

  it("excludes candidates whose URL is already attached to the current job", async () => {
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      {
        id: "already-on-job",
        name: "Already Attached",
        headline: "SCADA Engineer",
        location: "Christchurch, New Zealand",
        linkedinUrl: "https://www.linkedin.com/in/already-attached/",
        profileText: longProfile("SCADA RTU"),
        profileCapturedAt: new Date(),
        createdAt: new Date(),
      },
      {
        id: "new-hit",
        name: "Fresh Pool Person",
        headline: "Senior SCADA Engineer",
        location: "Christchurch, New Zealand",
        linkedinUrl: "https://www.linkedin.com/in/fresh-pool-person/",
        profileText: longProfile("SCADA RTU metering"),
        profileCapturedAt: new Date(),
        createdAt: new Date(),
      },
    ]);

    const summary = await searchTalentPoolForRole({
      parsedRole: POWER_ROLE,
      job: { isRemote: false },
      orgScope: "org-1",
      excludeLinkedInUrls: new Set([normaliseLinkedInUrl("https://www.linkedin.com/in/already-attached/")]),
      maxResults: 5,
      targetLocation: "Christchurch, New Zealand",
      scoringOrgId: "org-1",
      salary: null,
    });

    expect(summary.results).toHaveLength(1);
    expect(summary.results[0].hit.candidateId).toBe("new-hit");
  });

  it("specialist role: requires at least one role anchor in the candidate haystack — drops generic profiles", async () => {
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      {
        id: "scada-eng",
        name: "SCADA Pat",
        headline: "Senior SCADA Engineer at Transpower",
        location: "Wellington, New Zealand",
        linkedinUrl: "https://www.linkedin.com/in/scada-pat/",
        profileText: longProfile("SCADA RTU metering substation"),
        profileCapturedAt: new Date(),
        createdAt: new Date(),
      },
      {
        id: "generic-support",
        name: "Generic Support",
        headline: "Technical Support Engineer at Xero",
        location: "Wellington, New Zealand",
        linkedinUrl: "https://www.linkedin.com/in/generic-support/",
        profileText: longProfile("API integration support"),
        profileCapturedAt: new Date(),
        createdAt: new Date(),
      },
    ]);

    const summary = await searchTalentPoolForRole({
      parsedRole: POWER_ROLE,
      job: { isRemote: false },
      orgScope: "org-1",
      excludeLinkedInUrls: new Set(),
      maxResults: 5,
      targetLocation: "Wellington, New Zealand",
      scoringOrgId: "org-1",
      salary: null,
    });

    // Generic support engineer dropped at the pre-rank stage.
    expect(summary.preRankPool).toBe(1);
    expect(summary.shortlisted).toBe(1);
    expect(summary.results.map((r) => r.hit.candidateId)).toEqual(["scada-eng"]);
  });

  it("multi-anchor specialist role rejects C++ only profiles", async () => {
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      {
        id: "cpp-only",
        name: "CPP Only",
        headline: "Senior C++ Developer",
        location: "Wellington, New Zealand",
        linkedinUrl: "https://www.linkedin.com/in/cpp-only/",
        profileText: longProfile("C++ Linux distributed systems"),
        profileCapturedAt: new Date(),
        createdAt: new Date(),
      },
      {
        id: "cpp-sybase",
        name: "CPP Sybase",
        headline: "Senior C++ Developer",
        location: "Wellington, New Zealand",
        linkedinUrl: "https://www.linkedin.com/in/cpp-sybase/",
        profileText: longProfile("C++ development with Sybase ASE database systems"),
        profileCapturedAt: new Date(),
        createdAt: new Date(),
      },
    ]);

    const summary = await searchTalentPoolForRole({
      parsedRole: CPP_SYBASE_ROLE,
      job: { isRemote: false },
      orgScope: "org-1",
      excludeLinkedInUrls: new Set(),
      maxResults: 5,
      targetLocation: "Wellington, New Zealand",
      scoringOrgId: "org-1",
      salary: null,
    });

    expect(summary.results.map((r) => r.hit.candidateId)).toEqual(["cpp-sybase"]);
  });

  it("multi-anchor specialist role rejects Sybase only profiles", async () => {
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      {
        id: "sybase-only",
        name: "Sybase Only",
        headline: "Sybase DBA",
        location: "Wellington, New Zealand",
        linkedinUrl: "https://www.linkedin.com/in/sybase-only/",
        profileText: longProfile("Sybase ASE database administration and SQL tuning"),
        profileCapturedAt: new Date(),
        createdAt: new Date(),
      },
      {
        id: "cpp-sybase",
        name: "CPP Sybase",
        headline: "Senior C++ Developer",
        location: "Wellington, New Zealand",
        linkedinUrl: "https://www.linkedin.com/in/cpp-sybase/",
        profileText: longProfile("C++ development with Sybase ASE database systems"),
        profileCapturedAt: new Date(),
        createdAt: new Date(),
      },
    ]);

    const summary = await searchTalentPoolForRole({
      parsedRole: CPP_SYBASE_ROLE,
      job: { isRemote: false },
      orgScope: "org-1",
      excludeLinkedInUrls: new Set(),
      maxResults: 5,
      targetLocation: "Wellington, New Zealand",
      scoringOrgId: "org-1",
      salary: null,
    });

    expect(summary.results.map((r) => r.hit.candidateId)).toEqual(["cpp-sybase"]);
  });

  it("targeted rare-anchor pass rescues older pool profiles outside the newest slice", async () => {
    const olderRare = {
      id: "older-cpp-sybase",
      name: "Older Rare",
      headline: "Senior C++ Developer",
      location: "Wellington, New Zealand",
      linkedinUrl: "https://www.linkedin.com/in/older-rare/",
      profileText: longProfile("C++ development with Sybase ASE database systems"),
      profileCapturedAt: new Date("2024-01-01"),
      createdAt: new Date("2024-01-01"),
    };
    dbMocks.prisma.candidate.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([olderRare]);

    const summary = await searchTalentPoolForRole({
      parsedRole: CPP_SYBASE_ROLE,
      job: { isRemote: false },
      orgScope: "org-1",
      excludeLinkedInUrls: new Set(),
      maxResults: 5,
      targetLocation: "Wellington, New Zealand",
      scoringOrgId: "org-1",
      salary: null,
    });

    expect(dbMocks.prisma.candidate.findMany).toHaveBeenCalledTimes(2);
    expect(summary.results.map((r) => r.hit.candidateId)).toEqual(["older-cpp-sybase"]);
  });

  it("drops candidates whose location is explicitly overseas for non-remote roles", async () => {
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      {
        id: "sydney-cand",
        name: "Sydney Sam",
        headline: "Senior SCADA Engineer",
        location: "Sydney, Australia",
        linkedinUrl: "https://www.linkedin.com/in/sydney-sam/",
        profileText: longProfile("SCADA RTU"),
        profileCapturedAt: new Date(),
        createdAt: new Date(),
      },
      {
        id: "wellington-cand",
        name: "Wellington Will",
        headline: "Senior SCADA Engineer",
        location: "Wellington, New Zealand",
        linkedinUrl: "https://www.linkedin.com/in/wellington-will/",
        profileText: longProfile("SCADA RTU metering"),
        profileCapturedAt: new Date(),
        createdAt: new Date(),
      },
    ]);

    const summary = await searchTalentPoolForRole({
      parsedRole: POWER_ROLE,
      job: { isRemote: false },
      orgScope: "org-1",
      excludeLinkedInUrls: new Set(),
      maxResults: 5,
      targetLocation: "Wellington, New Zealand",
      scoringOrgId: "org-1",
      salary: null,
    });

    expect(summary.results.map((r) => r.hit.candidateId)).toEqual(["wellington-cand"]);
  });

  it("returns empty list when pool has no candidates", async () => {
    dbMocks.prisma.candidate.findMany.mockResolvedValue([]);
    const summary = await searchTalentPoolForRole({
      parsedRole: POWER_ROLE,
      job: { isRemote: false },
      orgScope: "org-1",
      excludeLinkedInUrls: new Set(),
      maxResults: 5,
      targetLocation: "Wellington, New Zealand",
      scoringOrgId: "org-1",
      salary: null,
    });
    expect(summary.results).toEqual([]);
    expect(summary.examined).toBe(0);
    expect(aiMocks.scoreCandidateStructured).not.toHaveBeenCalled();
  });

  it("caps Claude calls at shortlistLimit even when many candidates qualify", async () => {
    const rows = Array.from({ length: 80 }, (_, i) => ({
      id: `cand-${i}`,
      name: `Cand ${i}`,
      headline: "SCADA Engineer",
      location: "Wellington, New Zealand",
      linkedinUrl: `https://www.linkedin.com/in/cand-${i}/`,
      profileText: longProfile("SCADA RTU"),
      profileCapturedAt: new Date(),
      createdAt: new Date(),
    }));
    dbMocks.prisma.candidate.findMany.mockResolvedValue(rows);

    const summary = await searchTalentPoolForRole({
      parsedRole: POWER_ROLE,
      job: { isRemote: false },
      orgScope: "org-1",
      excludeLinkedInUrls: new Set(),
      maxResults: 50,
      shortlistLimit: 10,
      targetLocation: "Wellington, New Zealand",
      scoringOrgId: "org-1",
      salary: null,
    });

    expect(summary.preRankPool).toBe(80);
    expect(summary.shortlisted).toBe(10);
    expect(aiMocks.scoreCandidateStructured).toHaveBeenCalledTimes(10);
    expect(summary.results).toHaveLength(10);
  });

  it("uses default shortlist limit of 30 when not overridden", async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      id: `cand-${i}`,
      name: `Cand ${i}`,
      headline: "SCADA Engineer",
      location: "Wellington, New Zealand",
      linkedinUrl: `https://www.linkedin.com/in/cand-${i}/`,
      profileText: longProfile("SCADA RTU metering"),
      profileCapturedAt: new Date(),
      createdAt: new Date(),
    }));
    dbMocks.prisma.candidate.findMany.mockResolvedValue(rows);

    const summary = await searchTalentPoolForRole({
      parsedRole: POWER_ROLE,
      job: { isRemote: false },
      orgScope: "org-1",
      excludeLinkedInUrls: new Set(),
      maxResults: 100,
      targetLocation: "Wellington, New Zealand",
      scoringOrgId: "org-1",
      salary: null,
    });

    expect(POOL_SEARCH_DEFAULT_SHORTLIST).toBe(30);
    expect(summary.shortlisted).toBe(POOL_SEARCH_DEFAULT_SHORTLIST);
  });

  it("re-scores against the CURRENT role — does NOT trust any stale matchScore", async () => {
    // Candidate row exists but has no matchScore field selected — that's the
    // point: the function ignores it. The function builds a fresh score via
    // scoreCandidateStructured against parsedRole.
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      {
        id: "stale-row",
        name: "Stale",
        headline: "Senior SCADA Engineer",
        location: "Wellington, New Zealand",
        linkedinUrl: "https://www.linkedin.com/in/stale/",
        profileText: longProfile("SCADA RTU metering"),
        profileCapturedAt: new Date(),
        createdAt: new Date(),
      },
    ]);
    aiMocks.scoreCandidateStructured.mockResolvedValueOnce(makeBreakdown(81));

    const summary = await searchTalentPoolForRole({
      parsedRole: POWER_ROLE,
      job: { isRemote: false },
      orgScope: "org-1",
      excludeLinkedInUrls: new Set(),
      maxResults: 5,
      targetLocation: "Wellington, New Zealand",
      scoringOrgId: "org-1",
      salary: null,
    });

    expect(aiMocks.scoreCandidateStructured).toHaveBeenCalledWith(
      expect.stringContaining("Lorem ipsum"),
      POWER_ROLE,
      null,
      undefined,
      "org-1",
    );
    expect(summary.results[0].scoreBreakdown.overall).toBe(81);
  });

  it("survives Claude scoring failures on individual candidates without crashing", async () => {
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      {
        id: "ok",
        name: "OK Cand",
        headline: "SCADA Engineer",
        location: "Wellington, New Zealand",
        linkedinUrl: "https://www.linkedin.com/in/ok/",
        profileText: longProfile("SCADA RTU"),
        profileCapturedAt: new Date(),
        createdAt: new Date(),
      },
      {
        id: "fail",
        name: "Fail Cand",
        headline: "SCADA Engineer",
        location: "Wellington, New Zealand",
        linkedinUrl: "https://www.linkedin.com/in/fail/",
        profileText: longProfile("SCADA RTU"),
        profileCapturedAt: new Date(),
        createdAt: new Date(),
      },
    ]);
    aiMocks.scoreCandidateStructured
      .mockResolvedValueOnce(makeBreakdown(70))
      .mockRejectedValueOnce(new Error("Claude transient failure"));

    const summary = await searchTalentPoolForRole({
      parsedRole: POWER_ROLE,
      job: { isRemote: false },
      orgScope: "org-1",
      excludeLinkedInUrls: new Set(),
      maxResults: 5,
      targetLocation: "Wellington, New Zealand",
      scoringOrgId: "org-1",
      salary: null,
    });

    expect(summary.shortlisted).toBe(2);
    expect(summary.scored).toBe(1);
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0].hit.candidateId).toBe("ok");
  });

  it("respects minScore filter — drops candidates below threshold", async () => {
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      {
        id: "low",
        name: "Low Score",
        headline: "SCADA Engineer",
        location: "Wellington, New Zealand",
        linkedinUrl: "https://www.linkedin.com/in/low/",
        profileText: longProfile("SCADA RTU"),
        profileCapturedAt: new Date(),
        createdAt: new Date(),
      },
      {
        id: "high",
        name: "High Score",
        headline: "SCADA Engineer",
        location: "Wellington, New Zealand",
        linkedinUrl: "https://www.linkedin.com/in/high/",
        profileText: longProfile("SCADA RTU"),
        profileCapturedAt: new Date(),
        createdAt: new Date(),
      },
    ]);
    aiMocks.scoreCandidateStructured
      .mockResolvedValueOnce(makeBreakdown(45))
      .mockResolvedValueOnce(makeBreakdown(82));

    const summary = await searchTalentPoolForRole({
      parsedRole: POWER_ROLE,
      job: { isRemote: false },
      orgScope: "org-1",
      excludeLinkedInUrls: new Set(),
      maxResults: 5,
      minScore: 60,
      targetLocation: "Wellington, New Zealand",
      scoringOrgId: "org-1",
      salary: null,
    });

    expect(summary.results.map((r) => r.hit.candidateId)).toEqual(["high"]);
  });

  it("returns top maxResults sorted by overall score desc", async () => {
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      {
        id: "low",
        name: "Low",
        headline: "SCADA Engineer",
        location: "Wellington, New Zealand",
        linkedinUrl: "https://www.linkedin.com/in/low/",
        profileText: longProfile("SCADA RTU"),
        profileCapturedAt: new Date(),
        createdAt: new Date(),
      },
      {
        id: "med",
        name: "Med",
        headline: "SCADA Engineer",
        location: "Wellington, New Zealand",
        linkedinUrl: "https://www.linkedin.com/in/med/",
        profileText: longProfile("SCADA RTU"),
        profileCapturedAt: new Date(),
        createdAt: new Date(),
      },
      {
        id: "high",
        name: "High",
        headline: "SCADA Engineer",
        location: "Wellington, New Zealand",
        linkedinUrl: "https://www.linkedin.com/in/high/",
        profileText: longProfile("SCADA RTU"),
        profileCapturedAt: new Date(),
        createdAt: new Date(),
      },
    ]);
    aiMocks.scoreCandidateStructured
      .mockResolvedValueOnce(makeBreakdown(50))
      .mockResolvedValueOnce(makeBreakdown(70))
      .mockResolvedValueOnce(makeBreakdown(85));

    const summary = await searchTalentPoolForRole({
      parsedRole: POWER_ROLE,
      job: { isRemote: false },
      orgScope: "org-1",
      excludeLinkedInUrls: new Set(),
      maxResults: 2,
      targetLocation: "Wellington, New Zealand",
      scoringOrgId: "org-1",
      salary: null,
    });

    expect(summary.results.map((r) => r.hit.candidateId)).toEqual(["high", "med"]);
    expect(summary.returned).toBe(2);
    expect(summary.scored).toBe(3);
  });
});
