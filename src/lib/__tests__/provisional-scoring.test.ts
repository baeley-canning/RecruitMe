import { describe, expect, it } from "vitest";
import {
  buildProvisionalSearchScore,
  SCORE_CUTOFF_SNIPPET,
  SPECIALIST_SNIPPET_NO_ANCHOR_CAP,
} from "../provisional-scoring";
import {
  extractSignalsFromRequirement,
  signalMatchesText,
  normalizeSignalText,
} from "../requirement-signals";
import type { ParsedRole } from "../ai";

const deps = {
  requirementSignals: extractSignalsFromRequirement,
  hasSignal: signalMatchesText,
  normaliseText: normalizeSignalText,
};

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

describe("buildProvisionalSearchScore — specialist snippet cap", () => {
  // ── POWER role: SCADA / RTU / metering anchors ─────────────────────────────
  const powerRole = makeRole({
    title: "Technical Support and Sales Engineer (POWER)",
    location: "Christchurch",
    location_rules: "Christchurch office",
    must_haves: [
      "SCADA systems experience",
      "RTU configuration",
      "Power distribution / high voltage",
      "Field installation and commissioning",
      "Technical sales engineering",
    ],
    skills_required: ["SCADA", "RTU", "metering", "electrical engineering"],
    anchor_terms: [],
  });

  it("rejects generic 'Senior Technical Support Engineer' for POWER role (no SCADA/PLC/metering)", () => {
    // The agents flagged this as the canonical false-positive: a generic
    // technical-support snippet that title-matches but has zero domain spine
    // must NOT pass for a SCADA-required role.
    const score = buildProvisionalSearchScore(
      {
        name: "John Smith",
        headline: "Senior Technical Support Engineer at Vodafone",
        snippet: "Provides technical support and customer-facing escalation for telco accounts.",
      },
      powerRole,
      "Christchurch",
      "Christchurch",
      "Christchurch office",
      false,
      undefined,
      deps,
    );
    expect(score.overall).toBeLessThanOrEqual(SPECIALIST_SNIPPET_NO_ANCHOR_CAP);
    expect(score.overall).toBeLessThan(SCORE_CUTOFF_SNIPPET);
  });

  it("accepts 'Lead SCADA Engineer at Transpower NZ' for POWER role", () => {
    const score = buildProvisionalSearchScore(
      {
        name: "Jane Doe",
        headline: "Lead SCADA Engineer at Transpower NZ",
        snippet: "SCADA engineer at Transpower NZ. RTU configuration, substation telemetry, power distribution.",
      },
      powerRole,
      "Christchurch",
      "Christchurch",
      "Christchurch office",
      false,
      undefined,
      deps,
    );
    // Strong-spine snippet must clear the cap by a wide margin.
    expect(score.overall).toBeGreaterThan(SPECIALIST_SNIPPET_NO_ANCHOR_CAP);
  });

  // ── Compliance role: ISO 27001 anchor ──────────────────────────────────────
  const complianceRole = makeRole({
    title: "Technology and Solution Support Manager",
    location: "Wellington",
    must_haves: [
      "ISO 27001 / ISMS lead experience",
      "IT operations leadership",
      "Information security governance",
      "Technical support team leadership",
    ],
    skills_required: ["ISO 27001", "ISMS", "GRC"],
    anchor_terms: [],
  });

  it("rejects generic 'Senior IT Manager' snippet for Tech & Solution Support Manager role", () => {
    const score = buildProvisionalSearchScore(
      {
        name: "Bob Johnson",
        headline: "Senior IT Manager at Foo Corp",
        snippet: "Leads IT infrastructure and operations for a 300-person company.",
      },
      complianceRole,
      "Wellington",
      "Wellington",
      "Wellington office",
      false,
      undefined,
      deps,
    );
    expect(score.overall).toBeLessThanOrEqual(SPECIALIST_SNIPPET_NO_ANCHOR_CAP);
  });

  it("accepts 'ISMS Lead at Xero, ISO 27001 certified' for Tech & Solution Support Manager", () => {
    const score = buildProvisionalSearchScore(
      {
        name: "Alice Chen",
        headline: "ISMS Lead at Xero",
        snippet: "ISO 27001 certified ISMS lead. Drives information security governance and SOC 2 readiness.",
      },
      complianceRole,
      "Wellington",
      "Wellington",
      "Wellington office",
      false,
      undefined,
      deps,
    );
    expect(score.overall).toBeGreaterThan(SPECIALIST_SNIPPET_NO_ANCHOR_CAP);
  });

  // ── Common-role regression: must NOT change behaviour for ordinary roles ──
  it("does NOT cap ordinary developer roles (no distinctive anchors)", () => {
    // Generic "Software Engineer" role without distinctive anchors must
    // continue to work as before — the cap only applies when the role has
    // distinctive anchors (specialist gating).
    const ordinaryRole = makeRole({
      title: "Senior Software Engineer",
      must_haves: ["TypeScript experience", "React frontend"],
      skills_required: ["TypeScript", "React"],
    });
    const score = buildProvisionalSearchScore(
      {
        name: "Generic Dev",
        headline: "Senior Software Engineer at Local Co",
        snippet: "Full-stack developer using React and Node.js for a logistics platform.",
      },
      ordinaryRole,
      "Wellington",
      "Wellington",
      "Wellington office",
      false,
      undefined,
      deps,
    );
    // Ordinary search snippet should land at or above the floor (30) — the
    // cap is bypassed because the role has no distinctive anchors.
    expect(score.overall).toBeGreaterThanOrEqual(30);
  });
});
