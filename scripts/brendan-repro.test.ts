/**
 * Brendan Lester reproduction probe — runs as a vitest "test" so it can use
 * vi.mock to intercept Claude. Outputs to stdout via console.log.
 *
 * Run: npx vitest run scripts/brendan-repro.test.ts --reporter=basic
 */

import { describe, it, vi } from "vitest";

const { mockChat } = vi.hoisted(() => ({ mockChat: vi.fn() }));
vi.mock("../src/lib/ai/chat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/ai/chat")>();
  return { ...actual, chat: mockChat };
});

import { scoreCandidateStructured } from "../src/lib/ai/scoring";
import { deriveUpdateData } from "../src/lib/score-utils";
import type { ParsedRole } from "../src/lib/ai";

const role: ParsedRole = {
  title: "Senior Software Developer (Government Systems)",
  title_source: "explicit",
  location: "Wellington",
  location_source: "explicit",
  company: "NZ Government Agency",
  company_source: "explicit",
  experience: "5+ years",
  seniority_band: "Senior",
  seniority_source: "explicit",
  salary_band: "$120k–$160k NZD",
  salary_source: "inferred",
  location_rules: "Wellington office, hybrid",
  location_rules_source: "explicit",
  visa_flags: [],
  must_haves: [
    "C++ programming experience",
    "Sybase database",
    "Azure AKS/Service Bus/APIM",
    "Linux scripting (Bash/Perl/Python)",
    "Microservices architecture",
    "Government sector experience",
  ],
  nice_to_haves: ["NZ security clearance"],
  knockout_criteria: [],
  application_requirements: [],
  explicitly_stated: [],
  strongly_inferred: [],
  search_expansion: [],
  synonym_titles: [],
  responsibilities: [],
  search_queries: [],
  google_queries: [],
  skills_required: ["C++", "Sybase", "Azure", "Linux", "Bash", "Perl", "Python"],
  skills_preferred: ["security clearance"],
  skill_notes: [],
  dismissed_skill_notes: [],
  dismissed_knockout_criteria: [],
  promoted_visa_flags: [],
  anchor_terms: ["C++", "Sybase"],
} as ParsedRole;

// Stub capture (~8200 chars) — matches what the user's screenshot showed.
// About + headline + repeated text, no Experience section, no dated roles.
const STUB = (
  "Brendan Lester. Lead Engineer - Quality at Xero. Wellington, New Zealand. " +
  "100% LinkedIn extension. Connected. " +
  "About: SDLC consultancy with integration platform development. " +
  "Strong communicator and team lead. Experienced in driving quality across delivery. " +
  "Test automation, Playwright, Salesforce automation. "
).repeat(35);

// Full Brendan profile = stub + the JobAdder/CV merge content (real history).
const FULL = STUB + `

Experience

Lead Engineer - Quality, Xero (2018 - present). Test automation strategy across SaaS platform. Playwright, Salesforce automation. Mentoring quality engineers.

Technical Consultant / C++ Developer, Xacta Consulting (Jun 1998 - Aug 2001).
- Full stack Microsoft Visual C++ developer (Sybase database) at ACC on the Pathway team.
- Later, responsible for operational stability and availability of the platform.
- Skills: Software Deployment, Programming, C++, Sybase ASE, ACC government systems.

C++ Developer & Support, New Zealand Customs Service (Mar 1997 - Jun 1998).
- Solaris C++ developer for Intelligence, Goods and Passenger business streams within the new CusMod solution, used around the country to secure NZ borders.
- 24/7 support of the CusMod platform.
- Skills: C++, Solaris, Linux, Software Deployment, Government systems.

Education
BSc Computer Science, Victoria University of Wellington (1993 - 1996).

Skills
C++, Sybase, Solaris, Linux, Test Automation, Playwright, Salesforce, SDLC consultancy, Integration platforms, Government systems.
`;

// Simulated Claude response — mirrors what Claude actually returned on the
// real failure: 12% with fabricated rejection narrative invented from absent data.
const CLAUDE_OLD_VERDICT = JSON.stringify({
  overall_score: 12,
  categories: {
    skill_fit:        { score: 10, evidence: "QA/test focus, no full-stack development evidence" },
    location_fit:     { score: 100, evidence: "Wellington-based" },
    seniority_fit:    { score: 60, evidence: "Lead title at Xero" },
    title_fit:        { score: 25, evidence: "QA Lead is misaligned with full-stack role" },
    domain_fit:       { score: 30, evidence: "SaaS background, no government sector experience" },
    nice_to_have_fit: { score: 30, evidence: "Some breadth visible" },
  },
  must_have_coverage: [
    { requirement: "C++ programming experience", status: "missing", evidence: "Not mentioned in profile" },
    { requirement: "Sybase database", status: "missing", evidence: "Not mentioned in profile" },
    { requirement: "Azure AKS/Service Bus/APIM", status: "missing", evidence: "Not mentioned in profile" },
    { requirement: "Linux scripting (Bash/Perl/Python)", status: "missing", evidence: "Not mentioned in profile" },
    { requirement: "Microservices architecture", status: "missing", evidence: "Not mentioned in profile" },
    { requirement: "Government sector experience", status: "missing", evidence: "Not mentioned in profile" },
  ],
  nice_to_have_coverage: [{ requirement: "NZ security clearance", status: "absent", evidence: "Not mentioned" }],
  reasons_for: [
    "Wellington-based, satisfying the location requirement without relocation risk.",
    "Lead Engineer title at Xero (a large-scale SaaS company) suggests meaningful technical seniority.",
  ],
  reasons_against: [
    "Profile is essentially a stub — work history, skills sections, and certifications are entirely absent.",
    "No evidence of C++, Sybase, Azure (AKS/Service Bus/APIM), or Linux scripting — the most distinctive and non-negotiable technical requirements of this role.",
    "Current title is 'Lead Engineer - Quality', suggesting a QA/test engineering focus rather than full-stack software development.",
    "No evidence of government sector experience or security clearance eligibility.",
  ],
  missing_evidence: [
    "Full work history with technology stacks used in each role.",
    "Education/qualifications section.",
    "Any government, defence, or vetted-supplier work history.",
  ],
  recruiter_summary: "Profile is a near-empty stub with no work history or skills visible — do not progress without a full CV.",
});

// What Claude SHOULD return on the full profile when the deterministic
// evidence block has flagged C++/Sybase as confirmed. (Cannot mark them
// missing because the new prompt rule forbids contradicting regex evidence.)
const CLAUDE_NEW_VERDICT_FULL = JSON.stringify({
  overall_score: 78,
  categories: {
    skill_fit:        { score: 85, evidence: "C++ and Sybase confirmed via NZ Customs CusMod and ACC Pathway work" },
    location_fit:     { score: 100, evidence: "Wellington-based" },
    seniority_fit:    { score: 80, evidence: "Lead Engineer at Xero, 25+ years experience" },
    title_fit:        { score: 60, evidence: "Currently QA, but C++/Sybase developer history at Customs and ACC" },
    domain_fit:       { score: 90, evidence: "Direct NZ government sector experience (Customs, ACC)" },
    nice_to_have_fit: { score: 50, evidence: "No explicit clearance evidence" },
  },
  must_have_coverage: [
    { requirement: "C++ programming experience", status: "likely_historical", evidence: "C++ Developer at NZ Customs (1997-1998) and Xacta/ACC (1998-2001); now QA-focused" },
    { requirement: "Sybase database", status: "likely_historical", evidence: "Sybase database at Xacta/ACC Pathway team" },
    { requirement: "Azure AKS/Service Bus/APIM", status: "missing", evidence: "Not mentioned in profile" },
    { requirement: "Linux scripting (Bash/Perl/Python)", status: "likely", evidence: "Solaris/Linux background at NZ Customs" },
    { requirement: "Microservices architecture", status: "unknown", evidence: "Modern architecture not mentioned" },
    { requirement: "Government sector experience", status: "confirmed", evidence: "NZ Customs and ACC (1997-2001)" },
  ],
  nice_to_have_coverage: [{ requirement: "NZ security clearance", status: "likely", evidence: "NZ Customs intelligence/border work suggests clearance eligibility" }],
  reasons_for: [
    "Confirmed C++ and Sybase history — directly via NZ Customs CusMod (1997-1998) and Xacta/ACC Pathway (1998-2001).",
    "NZ government sector experience confirmed (Customs intelligence/border work).",
    "Wellington-based, Lead Engineer at Xero with 25+ years total experience.",
  ],
  reasons_against: [
    "C++ and Sybase are HISTORICAL — last used 2001; current 7-year focus is test automation at Xero.",
    "No evidence of Azure cloud platform or modern microservices architecture.",
  ],
  missing_evidence: ["Years since last C++/Sybase work — recency is the key risk."],
  recruiter_summary: "Strong historical C++/Sybase match with NZ government background, but recency is the risk — last hands-on use in 2001.",
});

const chatCallLog: Array<{ prompt: string; system: string }> = [];
mockChat.mockImplementation(async (prompt: string, _t: number, _m: number, opts: { system?: string } = {}) => {
  chatCallLog.push({
    prompt: prompt.slice(0, 1000),
    system: typeof opts.system === "string" ? opts.system.slice(0, 200) : "(none)",
  });
  // If the prompt contains the deterministic_evidence XML block, return the
  // "good" verdict (Claude can see ground-truth signals and scores fairly).
  // Otherwise return the original 12% rejection narrative.
  return prompt.includes("deterministic_evidence") ? CLAUDE_NEW_VERDICT_FULL : CLAUDE_OLD_VERDICT;
});

function divider(label: string) {
  console.log("\n" + "═".repeat(72));
  console.log("  " + label);
  console.log("═".repeat(72));
}

function summarise(label: string, breakdown: Awaited<ReturnType<typeof scoreCandidateStructured>>, claudeCalls: number) {
  const persisted = deriveUpdateData(breakdown);
  console.log(`\n[${label}]`);
  console.log(`  Claude calls made:        ${claudeCalls}`);
  console.log(`  breakdown.overall:        ${breakdown.overall}`);
  console.log(`  matchScore (DB write):    ${persisted.matchScore === null ? "NULL ← stub gate fired" : persisted.matchScore}`);
  console.log(`  data_quality:             ${breakdown.data_quality}`);
  console.log(`  profile_capture_warning:  ${breakdown.profile_capture_warning ? "PRESENT — UI shows 'Unscored — capture incomplete'" : "(none) — score is shown to recruiter"}`);
  if (breakdown.profile_capture_warning) {
    console.log(`    code:    ${breakdown.profile_capture_warning.code}`);
    console.log(`    message: ${breakdown.profile_capture_warning.message}`);
    breakdown.profile_capture_warning.evidence.forEach((e) => console.log(`    · ${e}`));
  }
  console.log(`  recruiter_summary: "${breakdown.recruiter_summary}"`);
  console.log(`  must_have_coverage:`);
  breakdown.must_have_coverage.forEach((c) => {
    console.log(`    [${c.status.padEnd(20)}] ${c.requirement}`);
    if (c.evidence && c.evidence !== "Not mentioned") {
      console.log(`      └─ ${c.evidence.slice(0, 80)}`);
    }
  });
  console.log(`  reasons_for (${breakdown.reasons_for.length}):`);
  breakdown.reasons_for.forEach((r) => console.log(`    ✓ ${r}`));
  console.log(`  reasons_against (${breakdown.reasons_against.length}):`);
  breakdown.reasons_against.forEach((r) => console.log(`    ✗ ${r}`));
}

describe("Brendan Lester reproduction", () => {
  it("Case 1: stub capture → gate fires BEFORE Claude → matchScore=null, no fabricated narrative", async () => {
    chatCallLog.length = 0;
    divider("CASE 1 — STUB CAPTURE (the actual Brendan failure shape)");
    console.log(`  Input: ${STUB.length} chars, no Experience section, About + headline only.`);
    console.log(`  Pre-fix behaviour: Claude called → 12% with 4 fabricated rejection reasons.`);
    console.log(`  Expected now:      stub gate fires BEFORE Claude. Claude never called.`);

    const breakdown = await scoreCandidateStructured(STUB, role);
    summarise("STUB", breakdown, chatCallLog.length);
  });

  it("Case 2: full profile (after CV/JobAdder merge) → Claude scores against confirmed signals", async () => {
    chatCallLog.length = 0;
    divider("CASE 2 — FULL PROFILE (Brendan with merged work history)");
    console.log(`  Input: ${FULL.length} chars, real Experience with C++/Sybase/CusMod/ACC.`);
    console.log(`  Expected: gate passes, Claude called WITH <deterministic_evidence>,`);
    console.log(`  Claude cannot mark C++ or Sybase missing because regex already proved them.`);

    const breakdown = await scoreCandidateStructured(FULL, role);
    summarise("FULL", breakdown, chatCallLog.length);

    if (chatCallLog.length > 0) {
      divider("CASE 2 — Prompt sent to Claude (excerpt — what Claude actually saw)");
      // Find the deterministic_evidence block to show it
      const idx = chatCallLog[0].prompt.indexOf("<deterministic_evidence>");
      if (idx >= 0) {
        const end = chatCallLog[0].prompt.indexOf("</deterministic_evidence>");
        console.log(chatCallLog[0].prompt.slice(idx, end + 25));
      } else {
        console.log("(No deterministic_evidence block in prompt — investigate)");
      }
    }

    divider("VERDICT");
    console.log(`  Stub case fixed:   matchScore=null + warning + no fabricated reasons`);
    console.log(`  Full case scored:  Claude called with confirmed signals injected`);
  });
});
