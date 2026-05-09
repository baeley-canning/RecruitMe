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
    // Strong-spine snippet must clear the SNIPPET cutoff (30) — not just the
    // cap (25). A weak `> 25` assertion would pass on a 26-point score, which
    // is below the import threshold. The 5-must-have role with a 5-token
    // snippet caps the achievable provisional score around mustHaveRatio
    // 3/5 — so we assert >cutoff (the import gate), not a hard 45 floor.
    expect(score.overall).toBeGreaterThan(SCORE_CUTOFF_SNIPPET);
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

  it("does NOT hard-reject generic 'Senior IT Manager' on a HYBRID IT role with light ISMS/ISO 27001 must-haves", () => {
    // Role-aware design (Option C): for hybrid IT-ops roles ("Technology and
    // Solution Support Manager", "IT Operations Manager"), ISMS / ISO 27001
    // are NOT distinctive source-gate anchors — they inform scoring but
    // don't cap. Otherwise we silently drop good IT-ops candidates whose
    // LinkedIn snippets don't surface those acronyms. The candidate gets a
    // moderate snippet score and either passes through to Claude full-profile
    // scoring or remains visible at the floor.
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
    // Cap MUST NOT fire — hybrid title strips ISMS/ISO 27001 from anchors.
    // Score lands above the snippet cutoff (30) so the candidate is visible.
    expect(score.overall).toBeGreaterThan(SPECIALIST_SNIPPET_NO_ANCHOR_CAP);
    expect(score.overall).toBeGreaterThanOrEqual(SCORE_CUTOFF_SNIPPET);
  });

  it("DOES hard-reject generic 'Senior IT Manager' on a PURE compliance role (ISMS Lead / CISO)", () => {
    // The flip side of the role-aware gate: when the role TITLE is genuinely
    // a pure compliance role, ISMS / ISO 27001 ARE distinctive anchors and
    // a generic IT Manager candidate without them must be capped. This
    // protects pure-compliance searches from flooding with random IT
    // candidates.
    const pureComplianceRole = makeRole({
      title: "ISMS Lead",
      location: "Wellington",
      must_haves: [
        "ISO 27001 ISMS implementation",
        "Information security governance",
        "Risk and compliance leadership",
      ],
      skills_required: ["ISO 27001", "ISMS", "GRC"],
      anchor_terms: [],
    });
    const score = buildProvisionalSearchScore(
      {
        name: "Bob Johnson",
        headline: "Senior IT Manager at Foo Corp",
        snippet: "Leads IT infrastructure and operations for a 300-person company.",
      },
      pureComplianceRole,
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
    // The snippet matches the ISMS / ISO 27001 / security-governance spine
    // but misses IT-ops-leadership and support-leadership must_haves, so
    // overall lands moderate. What matters is it clears the import cutoff
    // (30), proving the cap didn't fire.
    expect(score.overall).toBeGreaterThan(SCORE_CUTOFF_SNIPPET);
  });

  it("accepts ISMS-led snippets even when neither 'ISMS' nor 'ISO 27001' appear literally — long-form expansion alone is enough", () => {
    // The previous version of this test put "ISMS Lead at Xero" in the
    // headline, which trivially injected the literal token "isms" into the
    // haystack and made the cap pass for the wrong reason. The real claim
    // is: a candidate writing the LONG FORM ("information security
    // management system") gets recognised even without the abbreviation.
    // Headline is now neutral so only the snippet body carries the signal.
    const score = buildProvisionalSearchScore(
      {
        name: "Alex Kumar",
        headline: "Senior Security Manager at Xero",  // intentionally no ISMS/ISO27001
        snippet: "Owns the information security management system. Drives governance, risk and audit readiness across SaaS platforms.",
      },
      complianceRole,
      "Wellington",
      "Wellington",
      "Wellington office",
      false,
      undefined,
      deps,
    );
    // The cap matching now expands aliases via extractSignalsFromRequirement
    // — "information security management system" produces ["isms", ...]
    // which matches the role's distinctive anchors. Cap doesn't fire.
    expect(score.overall).toBeGreaterThan(SCORE_CUTOFF_SNIPPET);
  });

  it("ditto for PLC: 'programmable logic controller' in body alone is enough — no bare 'PLC' needed", () => {
    const plcRole = makeRole({
      title: "Industrial Controls Engineer",
      location: "Christchurch",
      must_haves: ["PLC integration"],
      skills_required: ["PLC integration", "industrial controls"],
    });
    const score = buildProvisionalSearchScore(
      {
        name: "Sam",
        headline: "Senior Controls Engineer at Mercury",
        snippet: "Programmable logic controller commissioning and ladder logic for substation automation.",
      },
      plcRole,
      "Christchurch", "Christchurch", "Christchurch office",
      false, undefined, deps,
    );
    expect(score.overall).toBeGreaterThan(SCORE_CUTOFF_SNIPPET);
  });

  it("ditto for RTU: 'remote terminal unit' in body alone is enough", () => {
    const rtuRole = makeRole({
      title: "Substation Telemetry Engineer",
      location: "Christchurch",
      must_haves: ["RTU experience"],
      skills_required: ["RTU"],
    });
    const score = buildProvisionalSearchScore(
      {
        name: "Pat",
        headline: "Senior Substation Engineer at Transpower",
        snippet: "Remote terminal unit configuration and substation telemetry rollout for the upper South Island grid.",
      },
      rtuRole,
      "Christchurch", "Christchurch", "Christchurch office",
      false, undefined, deps,
    );
    expect(score.overall).toBeGreaterThan(SCORE_CUTOFF_SNIPPET);
  });

  it("does not let Vodafone PLC satisfy PLC requirements through a bare company suffix", () => {
    const plcRole = makeRole({
      title: "Technical Support and Sales Engineer (POWER)",
      location: "Christchurch",
      location_rules: "Christchurch office",
      must_haves: ["PLC integration and configuration experience"],
      skills_required: ["PLC integration"],
    });

    const score = buildProvisionalSearchScore(
      {
        name: "Chris Taylor",
        headline: "Senior Technical Support Engineer at Vodafone PLC",
        snippet: "Provides enterprise customer support for network and cloud accounts.",
      },
      plcRole,
      "Christchurch",
      "Christchurch",
      "Christchurch office",
      false,
      undefined,
      deps,
    );
    expect(score.overall).toBeLessThan(SCORE_CUTOFF_SNIPPET);
  });

  it("accepts field-service / utilities engineer (Mercury / Vector style) — adjacent power-domain pool", () => {
    // Re-audit case D: a Mercury / Vector field-service engineer with
    // substation, commissioning, HV equipment, metering and data-logging
    // experience must clear the cap on a SCADA-required POWER role. The
    // earlier source-gate logic only checked legacy anchors [SCADA, RTU]
    // and ignored the rest of the distinctive set, dropping these
    // adjacent-pool candidates wrongly.
    const score = buildProvisionalSearchScore(
      {
        name: "Riley",
        headline: "Field Service Engineer at Mercury NZ",
        snippet: "Substation commissioning, HV equipment installation, smart metering and data logging across the lower North Island.",
      },
      powerRole,
      "Christchurch", "Christchurch", "Christchurch office",
      false, undefined, deps,
    );
    // The candidate matches multiple distinctive anchors via alias expansion
    // (metering, power distribution via substation/HV, commissioning).
    // Cap must NOT fire.
    expect(score.overall).toBeGreaterThan(SCORE_CUTOFF_SNIPPET);
  });

  it("does NOT cap when at least one distinctive anchor is present (partial match)", () => {
    // The cap only fires when ZERO distinctive anchors match the snippet.
    // A role with 4 anchors (SCADA / RTU / metering / electrical engineering)
    // and a snippet that mentions only ONE of them must pass — otherwise
    // we'd reject candidates whose primary anchor is named even when
    // adjacent anchors aren't.
    const score = buildProvisionalSearchScore(
      {
        name: "Pat Lee",
        headline: "Senior SCADA Engineer",
        snippet: "SCADA configuration for upper North Island grid; ICS systems experience.",
      },
      powerRole,
      "Christchurch",
      "Christchurch",
      "Christchurch office",
      false,
      undefined,
      deps,
    );
    // With "scada" present in the snippet, the cap is bypassed regardless of
    // whether RTU / metering / electrical engineering also appear.
    expect(score.overall).toBeGreaterThan(SCORE_CUTOFF_SNIPPET);
  });

  it("REGRESSION: a DevOps JD that uses 'process control' / 'process automation' must NOT trigger specialist gating", () => {
    // Critique flagged this as a real regression risk: the over-broad
    // `process\s+(?:control|automation)` regex was matching ordinary DevOps
    // JDs with phrases like "automated CI/CD process control for build
    // pipeline" and dragging every snippet into specialist gating. The
    // tightened regex requires an industrial qualifier or a downstream noun.
    const devopsRole = makeRole({
      title: "Senior DevOps Engineer",
      must_haves: [
        "Automated CI/CD process control for build pipelines",
        "Process automation across deployment workflows",
        "Industrial scale and reliability practices",
        "Kubernetes",
      ],
      skills_required: ["Kubernetes", "Terraform", "CI/CD"],
    });
    const score = buildProvisionalSearchScore(
      {
        name: "Sam Patel",
        headline: "Senior DevOps Engineer at Local Co",
        snippet: "DevOps engineer running Kubernetes and Terraform pipelines for a SaaS startup.",
      },
      devopsRole,
      "Wellington",
      "Wellington",
      "Wellington office",
      false,
      undefined,
      deps,
    );
    // Distinctive anchors should be ["Kubernetes"] only — not "industrial
    // controls". With Kubernetes present in the snippet, the cap doesn't
    // fire. (If "process control" still over-matched, ["industrial
    // controls"] would be in distinctive anchors, the snippet wouldn't
    // contain it, and the cap would drop the score below 30 — wrongly.)
    expect(score.overall).toBeGreaterThan(SCORE_CUTOFF_SNIPPET);
  });

  it("the cap actually REDUCES the score (not just lands on it by construction)", () => {
    // Two same-shape candidates on the same role: one with the anchor
    // present, one without. Proves the cap is doing real work — not just
    // an arithmetic identity.
    const withAnchor = buildProvisionalSearchScore(
      {
        name: "Kim",
        headline: "Senior SCADA Engineer at Vector",
        snippet: "SCADA, RTU, metering and substation work for the Auckland grid.",
      },
      powerRole, "Christchurch", "Christchurch", "Christchurch office", false, undefined, deps,
    );
    const withoutAnchor = buildProvisionalSearchScore(
      {
        name: "Kim",
        headline: "Senior Technical Support Engineer at Spark",
        snippet: "Technical support for ISP customers; ITIL v4 and incident management.",
      },
      powerRole, "Christchurch", "Christchurch", "Christchurch office", false, undefined, deps,
    );
    // Without-anchor was capped to 25 (we know exactly because cap fires
    // when overall would otherwise be > 25; floor doesn't apply when the
    // cap returns early).
    expect(withoutAnchor.overall).toBe(SPECIALIST_SNIPPET_NO_ANCHOR_CAP);
    // With-anchor score must be strictly higher — proves the cap reduced
    // a score that would otherwise be above 25.
    expect(withAnchor.overall).toBeGreaterThan(withoutAnchor.overall);
  });

  // ── Adjacent-domain pass-through (re-audit case): each of the 5 user-listed
  //    POWER-role candidates must clear the cap individually, even on a role
  //    that omits "electrical engineering" from skills_required (a stricter
  //    JD that lists only SCADA/RTU/metering/HV-substation). The test lives
  //    here so a future tightening of the DISTINCTIVE power-distribution
  //    regex doesn't silently re-block adjacent profiles.
  describe("re-audit: adjacent-domain POWER candidates clear the cap on a strict JD", () => {
    const strictPowerRole = makeRole({
      title: "POWER Systems Engineer",
      location: "Christchurch",
      location_rules: "Christchurch office",
      must_haves: [
        "SCADA systems experience",
        "RTU configuration",
        "HV switchgear and substation work",
        "Smart metering and data logging",
      ],
      // Intentionally NO "electrical engineering" — proves each candidate
      // clears on the basis of substation/HV/protection-relay anchors alone.
      skills_required: ["SCADA", "RTU", "metering"],
      anchor_terms: [],
    });

    const adjacentCandidates: Array<{ name: string; headline: string; snippet: string }> = [
      { name: "Cand 1", headline: "Substation commissioning engineer at Vector", snippet: "" },
      { name: "Cand 2", headline: "HV switchgear and power distribution field service engineer", snippet: "" },
      { name: "Cand 3", headline: "Utilities field engineer, substation automation and commissioning", snippet: "" },
      { name: "Cand 4", headline: "Power systems engineer, HV equipment, protection relays", snippet: "" },
      { name: "Cand 5", headline: "Electrical field service engineer, metering and data logging", snippet: "" },
    ];

    for (const c of adjacentCandidates) {
      it(`clears the cap: "${c.headline}"`, () => {
        const score = buildProvisionalSearchScore(
          c,
          strictPowerRole,
          "Christchurch", "Christchurch", "Christchurch office",
          false, undefined, deps,
        );
        expect(score.overall).toBeGreaterThanOrEqual(SCORE_CUTOFF_SNIPPET);
      });
    }

    it("noise control: 'Technical Support Engineer at Xero' (no power evidence) is still capped", () => {
      const score = buildProvisionalSearchScore(
        {
          name: "Noise",
          headline: "Technical Support Engineer at Xero",
          snippet: "Helping customers debug API integrations.",
        },
        strictPowerRole,
        "Christchurch", "Christchurch", "Christchurch office",
        false, undefined, deps,
      );
      expect(score.overall).toBeLessThan(SCORE_CUTOFF_SNIPPET);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  //  False-positive matrix — these candidates MUST NOT pass specialist gates
  //  even when superficial keywords might suggest they should.
  // ──────────────────────────────────────────────────────────────────────────
  describe("false-positive matrix — superficially-matching candidates that should be capped", () => {
    const scadaPowerRole = makeRole({
      title: "SCADA Engineer (POWER)",
      location: "Christchurch",
      must_haves: ["SCADA systems", "RTU configuration", "PLC programming"],
      skills_required: ["SCADA", "RTU", "PLC integration"],
    });

    const ismsLeadRole = makeRole({
      title: "ISMS Lead",
      location: "Wellington",
      must_haves: ["ISO 27001 ISMS implementation", "PCI DSS compliance experience"],
      skills_required: ["ISO 27001", "ISMS", "PCI DSS"],
    });

    const expectCappedOrFiltered = (overall: number) => {
      // Either capped to SPECIALIST_SNIPPET_NO_ANCHOR_CAP (25) or filtered
      // by the route at SCORE_CUTOFF_SNIPPET (30). Both outcomes prove
      // the candidate doesn't reach the recruiter for these roles.
      expect(overall).toBeLessThan(SCORE_CUTOFF_SNIPPET);
    };

    it("'Technical Support Engineer at Xero' MUST NOT pass POWER role gate", () => {
      const score = buildProvisionalSearchScore(
        { name: "X", headline: "Technical Support Engineer at Xero", snippet: "API integrations and customer support." },
        scadaPowerRole, "Christchurch", "Christchurch", "Christchurch office", false, undefined, deps,
      );
      expectCappedOrFiltered(score.overall);
    });

    it("'Sales Engineer (SaaS demos)' MUST NOT pass POWER role gate", () => {
      const score = buildProvisionalSearchScore(
        { name: "S", headline: "Sales Engineer at Atlassian", snippet: "Pre-sales demos and customer onboarding for SaaS platforms." },
        scadaPowerRole, "Christchurch", "Christchurch", "Christchurch office", false, undefined, deps,
      );
      expectCappedOrFiltered(score.overall);
    });

    it("'UX/HMI designer (mobile)' MUST NOT pass POWER role gate (HMI here means Human-Machine Interface in design context)", () => {
      const score = buildProvisionalSearchScore(
        { name: "D", headline: "UX Designer", snippet: "HMI design for mobile checkout flows; Figma component libraries." },
        scadaPowerRole, "Christchurch", "Christchurch", "Christchurch office", false, undefined, deps,
      );
      expectCappedOrFiltered(score.overall);
    });

    it("'DevOps engineer (CI/CD process control)' MUST NOT pass POWER role gate", () => {
      const score = buildProvisionalSearchScore(
        { name: "D", headline: "Senior DevOps Engineer", snippet: "Automated CI/CD process control for Kubernetes deployments." },
        scadaPowerRole, "Christchurch", "Christchurch", "Christchurch office", false, undefined, deps,
      );
      expectCappedOrFiltered(score.overall);
    });

    it("'RPA developer (process automation)' MUST NOT pass POWER role gate", () => {
      const score = buildProvisionalSearchScore(
        { name: "R", headline: "RPA Developer", snippet: "Process automation across deployment workflows for an RPA platform." },
        scadaPowerRole, "Christchurch", "Christchurch", "Christchurch office", false, undefined, deps,
      );
      expectCappedOrFiltered(score.overall);
    });

    it("'PCIe firmware engineer' MUST NOT pass an ISMS Lead role gate (PCIe ≠ PCI DSS)", () => {
      const score = buildProvisionalSearchScore(
        { name: "F", headline: "Embedded Firmware Engineer", snippet: "PCIe driver development and ARM Cortex bare-metal." },
        ismsLeadRole, "Wellington", "Wellington", "Wellington office", false, undefined, deps,
      );
      expectCappedOrFiltered(score.overall);
    });

    it("'Senior engineer at Vodafone PLC' MUST NOT pass POWER role gate via company-suffix collision", () => {
      const score = buildProvisionalSearchScore(
        { name: "V", headline: "Senior Engineer at Vodafone PLC", snippet: "Cloud platform and enterprise telco network engineering." },
        scadaPowerRole, "Christchurch", "Christchurch", "Christchurch office", false, undefined, deps,
      );
      expectCappedOrFiltered(score.overall);
    });

    it("'Generic Operating Systems Engineer (power management)' MUST NOT pass POWER role gate", () => {
      const score = buildProvisionalSearchScore(
        { name: "O", headline: "Senior Systems Engineer", snippet: "Operating systems power management and cloud platform engineering." },
        scadaPowerRole, "Christchurch", "Christchurch", "Christchurch office", false, undefined, deps,
      );
      expectCappedOrFiltered(score.overall);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  //  True-positive matrix — pure compliance roles MUST surface ISMS/ISO 27001
  //  / SOC 2 / PCI DSS candidates with anchor evidence
  // ──────────────────────────────────────────────────────────────────────────
  describe("true-positive matrix — pure compliance candidates pass on pure compliance roles", () => {
    const ismsLeadRole = makeRole({
      title: "ISMS Lead",
      location: "Wellington",
      must_haves: [
        "ISO 27001 ISMS implementation",
        "Information security governance",
        "Risk and compliance leadership",
      ],
      skills_required: ["ISO 27001", "ISMS", "GRC"],
    });

    it("'ISO 27001 Lead Implementer' passes the gate on ISMS Lead role", () => {
      const score = buildProvisionalSearchScore(
        { name: "L", headline: "ISO 27001 Lead Implementer at Spark", snippet: "ISMS implementation and ISO 27001 certification audits across SaaS platforms." },
        ismsLeadRole, "Wellington", "Wellington", "Wellington office", false, undefined, deps,
      );
      expect(score.overall).toBeGreaterThanOrEqual(SCORE_CUTOFF_SNIPPET);
    });

    it("'GRC Manager with security governance experience' passes the gate", () => {
      const score = buildProvisionalSearchScore(
        { name: "G", headline: "GRC Manager at BNZ", snippet: "Information security governance, ISMS audits and ISO 27001 readiness across enterprise." },
        ismsLeadRole, "Wellington", "Wellington", "Wellington office", false, undefined, deps,
      );
      expect(score.overall).toBeGreaterThanOrEqual(SCORE_CUTOFF_SNIPPET);
    });

    it("'SOC 2 auditor' passes — note SOC 2 surfaces via TECH alias to security compliance", () => {
      // SOC 2 isn't in DISTINCTIVE (intentionally — see requirement-signals.ts
      // comments) but it IS in TECH (security_compliance), so it informs
      // must-have coverage and the role gates on ISMS/ISO 27001 which the
      // candidate also has.
      const score = buildProvisionalSearchScore(
        { name: "S", headline: "SOC 2 Auditor at Deloitte", snippet: "ISO 27001 ISMS implementation and SOC 2 Type 2 audit experience for SaaS clients." },
        ismsLeadRole, "Wellington", "Wellington", "Wellington office", false, undefined, deps,
      );
      expect(score.overall).toBeGreaterThanOrEqual(SCORE_CUTOFF_SNIPPET);
    });

    it("'PCI DSS QSA' passes a PCI DSS-required role", () => {
      const pciRole = makeRole({
        title: "PCI DSS Auditor",
        location: "Wellington",
        must_haves: ["PCI DSS audit experience for payment processors", "ISO 27001 ISMS"],
        skills_required: ["PCI DSS", "ISO 27001"],
      });
      const score = buildProvisionalSearchScore(
        { name: "P", headline: "PCI DSS QSA at Datacom", snippet: "PCI DSS compliance audits for payment processing and ISO 27001 readiness." },
        pciRole, "Wellington", "Wellington", "Wellington office", false, undefined, deps,
      );
      expect(score.overall).toBeGreaterThanOrEqual(SCORE_CUTOFF_SNIPPET);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  //  POWER true-positive matrix — anchor candidates pass strict POWER role
  // ──────────────────────────────────────────────────────────────────────────
  describe("POWER true-positive matrix — anchor candidates pass strict POWER role", () => {
    const scadaRole = makeRole({
      title: "SCADA Engineer",
      location: "Christchurch",
      must_haves: ["SCADA systems experience", "RTU configuration"],
      skills_required: ["SCADA", "RTU"],
    });

    const trueCandidates: Array<{ headline: string; snippet: string }> = [
      { headline: "Senior SCADA Engineer at Transpower", snippet: "SCADA migration and substation telemetry." },
      { headline: "RTU Engineer at Mercury", snippet: "Remote terminal unit rollout and substation automation." },
      { headline: "Industrial Controls Engineer", snippet: "PLC programming, ladder logic and HMI integration with SCADA." },
      { headline: "Substation Engineer at Vector", snippet: "HV switchgear, substation commissioning and protection relays." },
      { headline: "Field Service Engineer at Genesis", snippet: "Smart metering and data logging across the upper North Island." },
    ];

    for (const c of trueCandidates) {
      it(`passes the gate: "${c.headline}"`, () => {
        const score = buildProvisionalSearchScore(
          { name: "C", ...c },
          scadaRole, "Christchurch", "Christchurch", "Christchurch office", false, undefined, deps,
        );
        expect(score.overall).toBeGreaterThanOrEqual(SCORE_CUTOFF_SNIPPET);
      });
    }
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
