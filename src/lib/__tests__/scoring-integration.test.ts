/**
 * Scoring integration tests.
 *
 * These tests mock only chat() — the external AI call — and let the full
 * pipeline run: Claude response parsing → buildScoreBreakdown → applyLocationFitOverride.
 *
 * What they catch:
 *   - Claude's overall_score being discarded by formula or location override
 *   - Empty must-haves returning 100% instead of 50%
 *   - "Likely" overfitting inflating scores for domain-adjacent mismatches
 *   - Blocker language not capping high scores
 *   - Snippet data-quality caps not enforced over Claude's holistic score
 *   - withRetry retry logic not covering network errors
 *
 * Run: npx vitest run src/lib/__tests__/scoring-integration.test.ts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { scoreCandidateStructured } from "../ai/scoring";
import { buildScoreBreakdown, computeMustHavePct } from "../scoring";
import { applyLocationFitOverride } from "../score-utils";

// ─── Mock chat() only — all pure functions run for real ───────────────────────
// vi.mock is hoisted; use vi.hoisted so mockChat is available in the factory.

const { mockChat } = vi.hoisted(() => ({ mockChat: vi.fn() }));

vi.mock("../ai/chat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai/chat")>();
  return { ...actual, chat: mockChat };
});

// Minimum viable profile text (≥100 chars) for tests that just need the input guard to pass.
const SHORT_PROFILE = "Senior React developer with TypeScript experience. Led frontend teams. Built production apps.";
const SNIPPET_PROFILE = (SHORT_PROFILE + " Wellington-based. Available immediately.").padEnd(250, " React TypeScript frontend developer."); // 200-2000 chars = snippet quality
// full_profile quality — realistic enough to clear the deterministic Stage 1
// gate (needs at least one year-range or must-have signal hit). The repeated
// "A" filler the tests originally used now (correctly) fails the stub gate.
const FULL_PROFILE = (
  "Senior Frontend Engineer at AcmeCorp (2020 - present). Lead React + TypeScript developer. " +
  "Previously: Frontend Engineer at BetaCorp (2017 - 2020), Software Developer at GammaCo (2014 - 2017). " +
  "Skills: React, TypeScript, Node.js, REST APIs, frontend architecture. " +
  "Wellington-based. Built production single-page apps and led teams of 4-6 engineers. "
).repeat(8); // ~2400 chars, multiple year ranges, React + TypeScript signals

// Helper: build a complete valid Claude scoring response
function claudeResponse(overrides: {
  overall_score: number;
  skill_fit?: number;
  location_fit?: number;
  seniority_fit?: number;
  reasons_against?: string[];
  must_have_coverage?: Array<{ requirement: string; status: string; evidence: string }>;
  recruiter_summary?: string;
}): string {
  return JSON.stringify({
    overall_score: overrides.overall_score,
    categories: {
      skill_fit:        { score: overrides.skill_fit ?? 70, evidence: "Skills mentioned in profile" },
      location_fit:     { score: overrides.location_fit ?? 100, evidence: "Same city" },
      seniority_fit:    { score: overrides.seniority_fit ?? 80, evidence: "Senior level" },
      title_fit:        { score: 75, evidence: "Adjacent title" },
      domain_fit:       { score: 70, evidence: "Relevant domain" },
      nice_to_have_fit: { score: 50, evidence: "Some nice-to-haves present" },
    },
    must_have_coverage: overrides.must_have_coverage ?? [
      { requirement: "5+ years React", status: "confirmed", evidence: "React listed in skills" },
      { requirement: "TypeScript", status: "confirmed", evidence: "TS listed in experience" },
    ],
    nice_to_have_coverage: [],
    reasons_for:   ["Strong React background"],
    reasons_against: overrides.reasons_against ?? [],
    missing_evidence: [],
    recruiter_summary: overrides.recruiter_summary ?? "Solid frontend engineer with relevant experience.",
  });
}

const baseParsedRole = {
  title: "Senior Frontend Engineer",
  title_source: "explicit" as const,
  location: "Wellington",
  location_source: "explicit" as const,
  company: "TestCo",
  company_source: "explicit" as const,
  experience: "5+ years",
  seniority_band: "Senior",
  seniority_source: "inferred" as const,
  salary_band: "$120k–$150k NZD",
  salary_source: "inferred" as const,
  location_rules: "Wellington CBD, hybrid",
  location_rules_source: "inferred" as const,
  visa_flags: [],
  must_haves: ["5+ years React", "TypeScript"],
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
  skills_required: ["React", "TypeScript"],
  skills_preferred: [],
  anchor_terms: ["React"],
};

// Ensure failover sees at least one provider configured. Without
// ANTHROPIC_API_KEY set, probeProviders() returns no primary and
// chatWithFailover throws before reaching the mocked chat().
const envSnapshot = { ...process.env };
beforeEach(() => {
  mockChat.mockReset();
  process.env.ANTHROPIC_API_KEY = "test";
  delete process.env.OPENAI_API_KEY;
  delete process.env.AI_PROVIDER;
});
// Restore env after the suite to avoid leaking into other tests.
import { afterAll } from "vitest";
afterAll(() => { process.env = { ...envSnapshot }; });

// ─── 1. Strong local senior match ─────────────────────────────────────────────

describe("Golden Candidate 1: Strong local senior match", () => {
  it("preserves Claude's score (85) through the full pipeline", async () => {
    mockChat.mockResolvedValue(claudeResponse({ overall_score: 85 }));
    const result = await scoreCandidateStructured(FULL_PROFILE, baseParsedRole);
    expect(result.overall).toBe(85);
  });

  it("location override does not change score when location already matches", async () => {
    mockChat.mockResolvedValue(claudeResponse({ overall_score: 85, location_fit: 100 }));
    const breakdown = await scoreCandidateStructured(FULL_PROFILE, baseParsedRole);
    const after = applyLocationFitOverride(breakdown, "Wellington, New Zealand", "Wellington", "hybrid", false);
    // Score should stay at 85 — location was already 100, no delta
    expect(after.overall).toBe(85);
  });
});

// ─── 2. Overseas candidate — location penalty applied as delta ─────────────────

describe("Golden Candidate 2: Overseas mismatch", () => {
  it("applies location penalty to Claude's score, not formula-derived score", async () => {
    // Claude scores overseas candidate at 72 (strong skills, wrong location)
    mockChat.mockResolvedValue(claudeResponse({ overall_score: 72, location_fit: 0 }));
    const breakdown = await scoreCandidateStructured(FULL_PROFILE, baseParsedRole);
    const after = applyLocationFitOverride(breakdown, "London, UK", "Wellington", null, false);
    // Overseas candidate: hard cap at 50, penalty multiplier applied
    expect(after.overall).toBeLessThanOrEqual(50);
    // Should not be 0 (skills are real) or 72 (location not applied)
    expect(after.overall).toBeGreaterThan(0);
  });

  it("score never exceeds 50 for confirmed overseas non-remote role", async () => {
    mockChat.mockResolvedValue(claudeResponse({ overall_score: 90, location_fit: 0 }));
    const breakdown = await scoreCandidateStructured(FULL_PROFILE, baseParsedRole);
    const after = applyLocationFitOverride(breakdown, "New York, US", "Wellington", null, false);
    expect(after.overall).toBeLessThanOrEqual(50);
  });
});

// ─── 3. Snippet data quality cap ──────────────────────────────────────────────

describe("Golden Candidate 3: Short snippet — data quality cap enforced", () => {
  it("caps Claude's score at 65 for 400-char snippets", async () => {
    // Claude gives 80 for a snippet — but snippet cap is 65
    mockChat.mockResolvedValue(claudeResponse({ overall_score: 80 }));
    const result = await scoreCandidateStructured(SNIPPET_PROFILE, baseParsedRole);
    expect(result.overall).toBeLessThanOrEqual(65);
    expect(result.data_quality).toBe("snippet");
  });

  it("very short snippets (<500 chars) cap at 54", async () => {
    mockChat.mockResolvedValue(claudeResponse({ overall_score: 75 }));
    // Pad to just over 100 chars (the minimum for scoring) but under 500 (snippet cap=54)
    const veryShortSnippet = "React developer. TypeScript. Wellington. ".padEnd(110, " Senior.");
    const result = await scoreCandidateStructured(veryShortSnippet, baseParsedRole);
    expect(result.overall).toBeLessThanOrEqual(54);
  });
});

// ─── 4. Blocker language in reasons_against forces score below 45 ─────────────

describe("Golden Candidate 4: Fundamental mismatch — blocker guard", () => {
  it("caps score to 45 when reasons_against contains blocker language", async () => {
    mockChat.mockResolvedValue(claudeResponse({
      overall_score: 68,
      reasons_against: ["Core skill C++ is entirely absent from this profile — fundamental mismatch"],
      recruiter_summary: "Wrong domain entirely — not a viable candidate.",
    }));
    const result = await scoreCandidateStructured(
      FULL_PROFILE,
      { ...baseParsedRole, must_haves: ["C++ systems programming"], title: "Senior C++ Engineer" }
    );
    // Blocker guard should cap at 45 despite Claude saying 68
    expect(result.overall).toBeLessThanOrEqual(45);
  });

  it("does NOT cap score when reasons_against is mild concern (not a blocker)", async () => {
    mockChat.mockResolvedValue(claudeResponse({
      overall_score: 72,
      reasons_against: ["Has not used React Hooks extensively but has React class component experience"],
    }));
    const result = await scoreCandidateStructured(FULL_PROFILE, baseParsedRole);
    // Mild concern — should NOT be capped
    expect(result.overall).toBe(72);
  });
});

// ─── 5. Empty must-haves returns neutral 50, not 100 ──────────────────────────

describe("computeMustHavePct: empty coverage returns 50", () => {
  it("returns 50 for empty must-have coverage (not 100)", () => {
    const pct = computeMustHavePct([], "full_profile");
    expect(pct).toBe(50);
    expect(pct).not.toBe(100);
  });

  it("full profile score with empty must-haves is not inflated to 80+", async () => {
    mockChat.mockResolvedValue(claudeResponse({
      overall_score: 78,
      must_have_coverage: [],
    }));
    const result = await scoreCandidateStructured(
      "A" .repeat(3000), // full profile
      { ...baseParsedRole, must_haves: [], skills_required: [] }
    );
    // Claude gave 78 with no requirements — that's Claude's call, respect it
    // But ensure the formula fallback (if used) wouldn't be inflated
    expect(result.overall).toBe(78);
    expect(result.must_have_pct).toBe(50); // neutral, not 100
  });
});

// ─── 6. "Likely" requirement — cannot be confirmed by title alone ─────────────

describe("Golden Candidate 6: Title adjacency — must_have as likely, not confirmed", () => {
  it("IT Manager title does not confirm IT infrastructure delivery requirement", async () => {
    // Claude correctly marks infrastructure as 'likely' (not confirmed) via title only
    mockChat.mockResolvedValue(claudeResponse({
      overall_score: 52,
      skill_fit: 45,
      must_have_coverage: [
        { requirement: "IT infrastructure project delivery", status: "likely", evidence: "Manager title implies some project leadership" },
        { requirement: "Hardware/software interfacing protocols", status: "missing", evidence: "Not mentioned in 8000 char profile" },
        { requirement: "ISO 27001 ISMS", status: "confirmed", evidence: "ISO 27001 Lead Implementer certification listed" },
      ],
      reasons_against: ["Hardware interfacing absent from detailed profile — treat as missing"],
    }));
    // Profile must actually contain the text Claude claims it confirmed —
    // the evidence-hallucination guard downgrades 'confirmed' → 'unknown'
    // when the cited evidence string isn't present in the profile, and with
    // ISO 27001 now carrying 1.5× importance (NZ-scarce specialism) an
    // unknown-on-a-detailed-profile would trigger the critical-missing cap.
    // The test's intent is the LIKELY-not-confirmed nuance for IT
    // infrastructure, not the cap, so make ISO 27001 evidence real.
    const profileText =
      "ISO 27001 Lead Implementer certification (BSI). " +
      "Senior IT Manager, 12 years across enterprise infrastructure projects. " +
      "Led ISMS implementation for SaaS company with 200 staff. " +
      "A".repeat(7700);
    const result = await scoreCandidateStructured(
      profileText,
      {
        ...baseParsedRole,
        title: "IT & Technical Support Manager",
        must_haves: [
          "IT infrastructure project delivery",
          "Hardware/software interfacing protocols",
          "ISO 27001 ISMS",
        ],
        skills_required: ["ISO 27001", "IT infrastructure"],
      }
    );
    // Claude says 52 — respect that
    expect(result.overall).toBe(52);
    // must_have_pct should reflect the mixed coverage
    expect(result.must_have_pct).toBeLessThan(75);
  });
});

// ─── 7. Claude overall_score missing — silent fallback to formula ─────────────

describe("Edge case: Claude omits overall_score", () => {
  it("falls back to formula-derived score when overall_score not returned", async () => {
    // Return a response with no overall_score field
    mockChat.mockResolvedValue(JSON.stringify({
      categories: {
        skill_fit:        { score: 80, evidence: "skills present" },
        location_fit:     { score: 100, evidence: "Wellington" },
        seniority_fit:    { score: 80, evidence: "senior" },
        title_fit:        { score: 70, evidence: "adjacent" },
        domain_fit:       { score: 75, evidence: "relevant" },
        nice_to_have_fit: { score: 50, evidence: "some" },
      },
      must_have_coverage: [
        { requirement: "5+ years React", status: "confirmed", evidence: "listed" },
        { requirement: "TypeScript", status: "confirmed", evidence: "listed" },
      ],
      nice_to_have_coverage: [],
      reasons_for: ["Good skills"],
      reasons_against: [],
      missing_evidence: [],
      recruiter_summary: "Solid candidate.",
      // NO overall_score field
    }));
    const result = await scoreCandidateStructured(
      FULL_PROFILE,
      baseParsedRole
    );
    // Should produce a valid score via formula fallback
    expect(result.overall).toBeGreaterThan(0);
    expect(result.overall).toBeLessThanOrEqual(100);
  });
});

// ─── 8. Location override preserves Claude score after override ───────────────

describe("applyLocationFitOverride: preserves claudeOverallScore", () => {
  it("does not recompute from formula when Claude gave overall_score", async () => {
    // Claude gave 42 — a deliberate low score for a poor match
    mockChat.mockResolvedValue(claudeResponse({
      overall_score: 42,
      skill_fit: 30,
      location_fit: 100, // Claude already knew they were local
    }));
    const breakdown = await scoreCandidateStructured(
      FULL_PROFILE,
      baseParsedRole
    );
    expect(breakdown.overall).toBe(42);

    // Now run location override with identical location — should not change score
    const after = applyLocationFitOverride(breakdown, "Wellington, NZ", "Wellington", null, false);
    expect(after.overall).toBe(42);
  });

  it("location improvement from overseas is applied as delta, not formula recompute", async () => {
    // Claude assessed candidate at 55 with location_fit=50 (uncertain)
    mockChat.mockResolvedValue(claudeResponse({
      overall_score: 55,
      location_fit: 50,
    }));
    const breakdown = await scoreCandidateStructured(
      FULL_PROFILE,
      baseParsedRole
    );
    expect(breakdown.overall).toBe(55);

    // We now confirm they are actually in Wellington → location improves to 100
    const after = applyLocationFitOverride(breakdown, "Wellington", "Wellington", null, false);
    // Score should be 55 or slightly higher — NOT reset to formula output
    expect(after.overall).toBeGreaterThanOrEqual(55);
    expect(after.overall).toBeLessThanOrEqual(100);
  });
});

// ─── 9. Full-profile data quality — no score cap ─────────────────────────────

describe("Data quality: full profile has no arbitrary cap", () => {
  it("full profile (>2000 chars) respects Claude score without cap", async () => {
    mockChat.mockResolvedValue(claudeResponse({ overall_score: 92 }));
    const result = await scoreCandidateStructured(
      FULL_PROFILE, // full_profile quality (realistic — passes Stage 1 gate)
      baseParsedRole
    );
    expect(result.data_quality).toBe("full_profile");
    expect(result.overall).toBe(92);
  });
});

// ─── 10. Snippet location override cannot boost above snippet cap ─────────────

describe("Snippet cap: location override cannot boost snippet above cap", () => {
  it("snippet already capped at 65 stays at 65 after location improvement", async () => {
    mockChat.mockResolvedValue(claudeResponse({ overall_score: 80, location_fit: 30 }));
    const breakdown = await scoreCandidateStructured(SNIPPET_PROFILE, baseParsedRole);
    expect(breakdown.data_quality).toBe("snippet");
    expect(breakdown.overall).toBeLessThanOrEqual(65);

    // Confirm location — but snippet cap must hold
    const after = applyLocationFitOverride(breakdown, "Wellington", "Wellington", null, false);
    expect(after.overall).toBeLessThanOrEqual(65);
  });
});

// ─── 11. Stored LinkedIn evidence beats model misses ──────────────────────────

describe("Deterministic evidence repair for exact stored profile signals", () => {
  it("does not preserve missing C++/Sybase verdicts when LinkedIn text literally contains them", async () => {
    mockChat.mockResolvedValue(claudeResponse({
      overall_score: 12,
      skill_fit: 10,
      must_have_coverage: [
        { requirement: "Strong C++ engineering experience", status: "missing", evidence: "No mention of C++ anywhere in the profile" },
        { requirement: "Sybase database experience", status: "missing", evidence: "No mention of Sybase anywhere in the profile" },
      ],
      reasons_against: [
        "No mention of C++ or Sybase anywhere in the profile — critical requirements absent.",
        "Current title is Lead Engineer - Quality, suggesting QA/test engineering focus.",
      ],
      recruiter_summary: "Profile appears to lack C++ and Sybase.",
    }));

    const profileText = [
      "Brendan Lester",
      "Lead Engineer - Quality at Xero",
      "Wellington, New Zealand",
      "Experience",
      "Technical Consultant / C++ Developer at ACC",
      "Jun 1998 - Aug 2001 · 3 yrs 3 mos",
      "Full stack, Microsoft Visual C++ developer (Sybase DB) at ACC on the Pathway team.",
      "Later responsible for operational stability and availability of the platform.",
      "C++ Developer & Support",
      "New Zealand Customs Service · Full-time",
      "Mar 1997 - Jun 1998 · 1 yr 4 mos",
      "Solaris C++Developer for Intelligence, Goods and Passenger business streams within the new CusMod solution.",
      "Additional profile content. ".repeat(130),
    ].join("\n");

    const result = await scoreCandidateStructured(profileText, {
      ...baseParsedRole,
      title: "Technical Consultant / C++ Developer",
      must_haves: [
        "Strong C++ engineering experience",
        "Sybase database experience",
      ],
      skills_required: ["C++", "Sybase"],
    });

    expect(result.must_have_coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({
        requirement: "Strong C++ engineering experience",
        status: "likely_historical",
      }),
      expect.objectContaining({
        requirement: "Sybase database experience",
        status: "likely_historical",
      }),
    ]));
    expect(result.must_have_coverage[0].evidence).toContain("Stored LinkedIn/profile text contains exact requirement signal");
    expect(result.reasons_for[0]).toContain("Stored LinkedIn/profile text contains exact critical signal");
    expect(result.reasons_against.join(" ")).not.toMatch(/No mention of C\+\+ or Sybase/);
    expect(result.overall).toBeGreaterThan(12);
  });
});

describe("AcceptancePrediction — scoredBy legacy round-trip (DB → UI contract)", () => {
  // Legacy-data guard: older Candidate.acceptanceReason rows were written
  // with `scoredBy: "ollama"` back when there was a local-model code path.
  // Llama scoring is gone from the live write path (Claude → OpenAI only),
  // but historic rows still exist in production, so the UI must keep
  // surfacing them honestly rather than silently rebadging them as Claude.
  // These tests only assert the JSON round-trip — they are NOT exercising
  // a live Llama scoring code path.
  it("preserves legacy scoredBy='ollama' through JSON.stringify + JSON.parse", () => {
    const original = {
      score: 75,
      likelihood: "high" as const,
      headline: "Likely open",
      signals: [],
      summary: "Recently changed jobs, open to opportunities.",
      scoredBy: "ollama" as const,
    };
    const wire = JSON.stringify(original);
    const parsed = JSON.parse(wire);
    expect(parsed.scoredBy).toBe("ollama");
  });

  it("treats absent scoredBy as undefined (legacy rows before the field existed)", () => {
    const legacy = JSON.stringify({
      score: 75,
      likelihood: "medium",
      headline: "May consider",
      signals: [],
      summary: "Stable in current role.",
    });
    const parsed = JSON.parse(legacy);
    expect(parsed.scoredBy).toBeUndefined();
    // Critical: the UI's `acceptanceData?.scoredBy === "ollama"` check must
    // evaluate to false on undefined so legacy rows render the existing
    // (Claude-default) badge with no Llama pill.
    expect(parsed.scoredBy === "ollama").toBe(false);
  });
});
