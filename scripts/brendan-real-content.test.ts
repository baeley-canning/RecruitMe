/**
 * Diagnostic: what does the new pipeline do when Brendan's REAL capture
 * (with the actual C++/Sybase/CusMod work history visible) goes through it?
 *
 * Three increasingly-rich captures simulating what the LinkedIn extension
 * might pull, plus the JobAdder-merged version. Shows expected behaviour.
 */

import { beforeAll, describe, it, vi } from "vitest";

const { mockChat } = vi.hoisted(() => ({ mockChat: vi.fn() }));
vi.mock("../src/lib/ai/chat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/ai/chat")>();
  return { ...actual, chat: mockChat };
});

// chatWithFailover requires at least one provider key. Set ANTHROPIC_API_KEY
// here so the failover wrapper can resolve a primary and forward to the
// mocked chat(). Without this, probeProviders() returns no primary and
// chatWithFailover throws before hitting the mock.
beforeAll(() => { process.env.ANTHROPIC_API_KEY = "test"; });

import { scoreCandidateStructured } from "../src/lib/ai/scoring";
import { runDeterministicMatch } from "../src/lib/scoring";
import { extractSignalsFromRequirement, signalMatchesText } from "../src/lib/requirement-signals";
import { deriveUpdateData } from "../src/lib/score-utils";
import type { ParsedRole } from "../src/lib/ai";

const role: ParsedRole = {
  title: "Software Developer (Government Systems)",
  title_source: "explicit",
  location: "Wellington",
  location_source: "explicit",
  company: "NZ Customs",
  company_source: "explicit",
  experience: "5+ years",
  seniority_band: "Mid-level",
  seniority_source: "explicit",
  salary_band: "$120k–$160k NZD",
  salary_source: "inferred",
  location_rules: "Wellington office",
  location_rules_source: "explicit",
  visa_flags: [],
  must_haves: [
    "C++ programming experience",
    "Sybase database",
    "Azure cloud (AKS / Service Bus / APIM)",
    "Linux scripting (Bash / Perl / Python)",
    "Microservices architecture",
    "Government sector experience",
  ],
  nice_to_haves: ["Security clearance"],
  knockout_criteria: [],
  application_requirements: [],
  explicitly_stated: [],
  strongly_inferred: [],
  search_expansion: [],
  synonym_titles: [],
  responsibilities: [],
  search_queries: [],
  google_queries: [],
  skills_required: ["C++", "Sybase", "Azure", "Linux"],
  skills_preferred: [],
  skill_notes: [],
  dismissed_skill_notes: [],
  dismissed_knockout_criteria: [],
  promoted_visa_flags: [],
  anchor_terms: ["C++", "Sybase"],
} as ParsedRole;

const deps = { expandSignals: extractSignalsFromRequirement, matchSignal: signalMatchesText };

// ─── Three capture qualities ──────────────────────────────────────────────

// 1. The actual stub — no work history visible.
const STUB_CAPTURE = (
  "Brendan Lester. Lead Engineer - Quality at Xero. Wellington, New Zealand. " +
  "About: SDLC consultancy with integration platform development. " +
  "Strong communicator. Test automation. Playwright, Salesforce automation. "
).repeat(35);

// 2. Realistic capture: Experience section captured, includes the historical
//    C++/Sybase roles. This is what a HEALTHY extension fetch produces.
const FULL_CAPTURE = `
Brendan Lester
Lead Engineer - Quality
Xero · Wellington, New Zealand

About
SDLC consultancy with integration platform development. Test automation, Playwright, Salesforce automation. Mentoring quality engineers.

Experience
Lead Engineer - Quality · Xero
Jan 2018 - Present · 7 yrs · Wellington, New Zealand
Test automation strategy. Playwright. Salesforce automation. Quality across SaaS delivery.

Technical Consultant / C++ Developer · Xacta Consulting
Jun 1998 - Aug 2001 · 3 yrs 3 mos · Wellington
Full stack Microsoft Visual C++ developer (Sybase database) at ACC on the Pathway team. Later, responsible for operational stability of the platform.
Skills: Software Deployment, Programming, C++, Sybase ASE, ACC government systems

C++ Developer & Support · New Zealand Customs Service
Mar 1997 - Jun 1998 · 1 yr 4 mos · Wellington · On-site
Solaris C++ developer for Intelligence, Goods and Passenger streams within the new CusMod solution, used around the country to secure NZ borders. 24/7 support of the CusMod platform.
Skills: C++, Solaris, Linux, Software Deployment, Government systems

Education
Victoria University of Wellington
BSc Computer Science · 1993 - 1996

Skills
C++ · Sybase · Solaris · Linux · Test Automation · Playwright · Salesforce · SDLC consultancy · Integration platforms · Government systems
`;

// 3. Partial capture: scrape got headline + about + ONE recent role but
//    cut off before the historical C++/Sybase work. Common LinkedIn DOM
//    failure mode (Show More not clicked).
const PARTIAL_CAPTURE = `
Brendan Lester
Lead Engineer - Quality
Xero · Wellington, New Zealand

About
SDLC consultancy with integration platform development. Test automation strategy across Xero's SaaS platform. Strong communicator and team lead. Mentoring quality engineers across multiple delivery streams.

Experience
Lead Engineer - Quality · Xero
Jan 2018 - Present · 7 yrs · Wellington, New Zealand
Test automation strategy. Playwright. Salesforce automation. Quality leadership.

[Show more — 8 more positions]
`.padEnd(8200, " More profile data and skills sections that LinkedIn rendered but the scraper missed when the Show More button wasn't clicked. ");

// Helper: mock Claude returning the canonical "incomplete capture" recruiter
// summary alongside a numeric score — exactly what Brendan's production row
// produced. Used to verify the post-Claude AI-stub branch fires.
function claudePartialCaptureResponse(numericScore: number) {
  return JSON.stringify({
    overall_score: numericScore,
    categories: {
      skill_fit: { score: 30, evidence: "QA/test focus visible; older C++ history not in capture" },
      location_fit: { score: 100, evidence: "Wellington" },
      seniority_fit: { score: 70, evidence: "Lead title at Xero" },
      title_fit: { score: 40, evidence: "QA Lead" },
      domain_fit: { score: 50, evidence: "SaaS background, no government evidence in capture" },
      nice_to_have_fit: { score: 30, evidence: "Some breadth" },
    },
    must_have_coverage: role.must_haves.map((r) => ({ requirement: r, status: "missing", evidence: "Not mentioned" })),
    nice_to_have_coverage: [],
    reasons_for: ["Wellington-based", "Lead at Xero"],
    reasons_against: [
      "C++ and Sybase not visible in captured profile text.",
      "No government sector experience in current capture.",
    ],
    missing_evidence: [
      "Full work history with technology stacks used in each role.",
    ],
    // Claude follows the INCOMPLETE PROFILE RULE in the prompt and emits
    // this canonical summary even when returning a numeric score.
    recruiter_summary: "LinkedIn capture is incomplete — do not progress or reject without full work history or CV.",
  });
}

mockChat.mockImplementation(async (prompt: string) => {
  // Mock Claude based on what's in the prompt — if deterministic_evidence
  // lists C++/Sybase as confirmed, return a fair score; otherwise return
  // the original 12% rejection for stub-shaped content.
  const hasDetEvidence = prompt.includes("<deterministic_evidence>");
  const cppConfirmed = hasDetEvidence && /C\+\+/i.test(prompt.split("<deterministic_evidence>")[1]?.split("</deterministic_evidence>")[0] ?? "");

  if (cppConfirmed) {
    return JSON.stringify({
      overall_score: 72,
      categories: {
        skill_fit: { score: 75, evidence: "C++ and Sybase confirmed at NZ Customs and ACC; recency is the concern" },
        location_fit: { score: 100, evidence: "Wellington" },
        seniority_fit: { score: 80, evidence: "Lead Engineer, 25+ years experience" },
        title_fit: { score: 55, evidence: "Currently QA, but historical full-stack C++ developer" },
        domain_fit: { score: 90, evidence: "Direct NZ government sector experience (Customs, ACC)" },
        nice_to_have_fit: { score: 50, evidence: "No explicit clearance" },
      },
      must_have_coverage: [
        { requirement: "C++ programming experience", status: "likely_historical", evidence: "C++ Developer at NZ Customs (1997-1998), Xacta/ACC (1998-2001); now QA" },
        { requirement: "Sybase database", status: "likely_historical", evidence: "Sybase ASE at Xacta/ACC Pathway team" },
        { requirement: "Azure cloud (AKS / Service Bus / APIM)", status: "missing", evidence: "Not mentioned" },
        { requirement: "Linux scripting (Bash / Perl / Python)", status: "likely", evidence: "Solaris/Linux at Customs" },
        { requirement: "Microservices architecture", status: "unknown", evidence: "Modern architecture not mentioned" },
        { requirement: "Government sector experience", status: "confirmed", evidence: "NZ Customs and ACC (1997-2001)" },
      ],
      nice_to_have_coverage: [{ requirement: "Security clearance", status: "likely", evidence: "Customs intelligence/border work" }],
      reasons_for: [
        "Confirmed C++ and Sybase experience at NZ Customs (CusMod) and Xacta/ACC.",
        "Direct NZ government sector background — Customs and ACC.",
        "Lead Engineer at Xero, 25+ years total experience.",
      ],
      reasons_against: [
        "C++ and Sybase are HISTORICAL — last hands-on use 2001.",
        "No Azure cloud platform or modern microservices evidence.",
      ],
      missing_evidence: ["Years since last C++/Sybase use; modern stack experience"],
      recruiter_summary: "Strong historical C++/Sybase + NZ government background. Recency is the key risk — last hands-on in 2001.",
    });
  }

  // Partial-capture fallback (Brendan production case): Claude is following
  // the INCOMPLETE PROFILE RULE and returns the canonical recruiter_summary
  // alongside a numeric score. The post-Claude AI-stub check should catch
  // this and null the matchScore.
  return claudePartialCaptureResponse(40);
});

function divider(s: string) {
  console.log("\n" + "═".repeat(72));
  console.log("  " + s);
  console.log("═".repeat(72));
}

function summarise(label: string, profileText: string, breakdown: Awaited<ReturnType<typeof scoreCandidateStructured>>, claudeCalls: number) {
  const determ = runDeterministicMatch({ profileText, mustHaves: role.must_haves, ...deps });
  const persisted = deriveUpdateData(breakdown);
  console.log(`\n[${label}]`);
  console.log(`  Stage 1 deterministic match:`);
  console.log(`    chars:           ${determ.charCount}`);
  console.log(`    rolesDetected:   ${determ.rolesDetected}`);
  console.log(`    matchedSignals:  [${determ.matchedSignals.join(", ")}]`);
  console.log(`    sufficient:      ${determ.sufficient}${determ.sufficient ? "" : " ← gate fires, Claude skipped"}`);
  console.log(`  Pipeline result:`);
  console.log(`    Claude calls:    ${claudeCalls}`);
  console.log(`    overall:         ${breakdown.overall}`);
  console.log(`    matchScore (DB): ${persisted.matchScore === null ? "NULL" : persisted.matchScore}`);
  console.log(`    warning:         ${breakdown.profile_capture_warning ? "incomplete_capture (UI shows 'Unscored')" : "(none)"}`);
  console.log(`    summary:         "${breakdown.recruiter_summary.slice(0, 100)}${breakdown.recruiter_summary.length > 100 ? "…" : ""}"`);
  console.log(`    must-haves:`);
  breakdown.must_have_coverage.forEach((c) => {
    console.log(`      [${c.status.padEnd(20)}] ${c.requirement}`);
  });
}

let chatCalls = 0;
const origImpl = mockChat.getMockImplementation();
mockChat.mockImplementation(async (...args: Parameters<NonNullable<typeof origImpl>>) => {
  chatCalls++;
  return origImpl!(...args);
});

describe("Brendan — three capture qualities through the new pipeline", () => {
  it("(A) STUB capture (extension missed Experience section)", async () => {
    chatCalls = 0;
    divider("(A) STUB CAPTURE — extension missed Experience section");
    const breakdown = await scoreCandidateStructured(STUB_CAPTURE, role);
    summarise("STUB", STUB_CAPTURE, breakdown, chatCalls);
    console.log(`\n  Verdict: matchScore=NULL is CORRECT for this case — there's literally no`);
    console.log(`  work history captured. UI shows "Unscored — capture incomplete + Upload CV".`);
  });

  it("(B) FULL capture (Experience section pulled — includes C++ at NZ Customs)", async () => {
    chatCalls = 0;
    divider("(B) FULL CAPTURE — Experience section captured, real C++/Sybase history visible");
    const breakdown = await scoreCandidateStructured(FULL_CAPTURE, role);
    summarise("FULL", FULL_CAPTURE, breakdown, chatCalls);
    console.log(`\n  Verdict: real score (72%) reflecting Brendan's actual fit. C++/Sybase`);
    console.log(`  marked confirmed/likely_historical (NEVER missing — regex proved them).`);
    console.log(`  recruiter_summary names the actual concern: recency, not absence.`);
  });

  it("(C) PARTIAL capture (current role visible, historical roles cut off)", async () => {
    chatCalls = 0;
    divider("(C) PARTIAL CAPTURE — current Xero role visible, older C++/Sybase roles missed");
    const breakdown = await scoreCandidateStructured(PARTIAL_CAPTURE, role);
    summarise("PARTIAL", PARTIAL_CAPTURE, breakdown, chatCalls);
    console.log(`\n  Verdict: depends on what Stage 1 finds. If current Xero role + section`);
    console.log(`  markers exist → gate passes → Claude scores. C++/Sybase will be 'missing'`);
    console.log(`  because they're genuinely not in the captured text — that's the recruiter's`);
    console.log(`  cue to upload CV or click 'Show more' on LinkedIn before re-fetching.`);
  });
});
