/**
 * One-off script to print the rendered system + user prompt that
 * scoreCandidatesBatch sends to Claude. Run with `tsx` or `ts-node`:
 *
 *   npx tsx scripts/dump-batch-scoring-prompt.ts
 *
 * Not wired into anything — just a sanity-check aid for prompt review.
 */

import {
  SCORING_SYSTEM_CONTEXT,
  SCORING_JSON_SCHEMA,
  SCORING_OVERALL_RULE,
  SCORING_CATEGORY_RULES,
  SCORING_MUST_HAVE_RULES,
  SCORING_KNOCKOUT_RULE,
  SCORING_GROUPED_REQUIREMENT_RULE,
  SCORING_NICE_TO_HAVE_RULES,
  SCORING_REASONS_RULES,
  SCORING_SNIPPET_RULE,
  SCORING_DEGREE_RULES,
  SCORING_EQUIVALENCY_RULES,
} from "../src/lib/ai/prompts/scoring";
import { escapeXmlForPrompt } from "../src/lib/profile-excerpt";

const parsedRole = {
  title: "Senior Full Stack Developer",
  location: "Wellington / Christchurch",
  seniority_band: "senior",
  must_haves: [
    "C++ development experience",
    "Sybase database experience",
    "Full stack web development",
    "Experience working in an agile environment",
  ],
  nice_to_haves: ["Microservices architecture", "AWS / Azure"],
  knockout_criteria: [] as string[],
};

const salaryLine = "Budget: $130k–$170k NZD";
const seniorityLine = `Seniority: ${parsedRole.seniority_band}`;
const knockoutLine = "";
const clearanceLine = "";
const mustHavesList = parsedRole.must_haves.map((m, i) => `${i + 1}. ${m}`).join("\n");
const niceList = parsedRole.nice_to_haves.map((n, i) => `${i + 1}. ${n}`).join("\n");

const candidates = [
  {
    candidateId: "c_thomas",
    matchedSignals: ["C++", "Sybase"],
    profileSlice: `Thomas Kux
Lead Engineer at FINEOS
Wellington, New Zealand

Experience
Lead Engineer · FINEOS · Wellington · 2019 – Present
Architecting claims platforms in C++ and PL/SQL...

Senior Software Engineer · ACC Pathway · 2008 – 2019
Sybase ASE, C++ application services.`,
  },
  {
    candidateId: "c_brendan",
    matchedSignals: [] as string[],
    profileSlice: `Brendan Lester
Lead Engineer - Quality at Xero
Wellington, New Zealand

(no Experience section captured)`,
  },
  {
    candidateId: "c_alex",
    matchedSignals: ["full stack"],
    profileSlice: `Alex Patel
Staff Engineer at Xero
Christchurch, New Zealand

Experience
Staff Engineer · Xero · Christchurch · 2021 – Present
Full stack TypeScript + Go services across reporting platform.

Senior Engineer · Trade Me · 2016 – 2021`,
  },
];

const systemInstructions = [
  SCORING_SYSTEM_CONTEXT,
  SCORING_JSON_SCHEMA,
  SCORING_OVERALL_RULE,
  SCORING_CATEGORY_RULES,
  SCORING_MUST_HAVE_RULES,
  parsedRole.knockout_criteria.length ? SCORING_KNOCKOUT_RULE : "",
  SCORING_GROUPED_REQUIREMENT_RULE,
  SCORING_NICE_TO_HAVE_RULES,
  SCORING_REASONS_RULES,
  SCORING_SNIPPET_RULE,
  SCORING_DEGREE_RULES,
  SCORING_EQUIVALENCY_RULES,
].filter(Boolean).join("\n\n");

const candidatesBlock = candidates.map((c) => {
  const matchedBlock = c.matchedSignals.length
    ? `<deterministic_evidence>
The following requirements are CONFIRMED present via word-boundary regex match. You MUST mark them "confirmed" or "equivalent" — never "missing", "unknown", or "negative".
${c.matchedSignals.map((m, i) => `${i + 1}. ${escapeXmlForPrompt(m)}`).join("\n")}
</deterministic_evidence>\n`
    : "";
  return `<candidate id="${escapeXmlForPrompt(c.candidateId)}">
${matchedBlock}<profile>
${escapeXmlForPrompt(c.profileSlice)}
</profile>
</candidate>`;
}).join("\n\n");

const userPrompt = `Role: ${parsedRole.title} | ${parsedRole.location} | ${salaryLine} | ${seniorityLine}

Must-haves (numbered — include ALL in EACH candidate's must_have_coverage):
${mustHavesList}

Nice-to-haves (numbered — include ALL in EACH candidate's nice_to_have_coverage):
${niceList}
${knockoutLine}
${clearanceLine}

You will receive ${candidates.length} candidate${candidates.length === 1 ? "" : "s"} below. Score each one INDEPENDENTLY against the role. Each candidate's narrative MUST stand alone — do NOT reference other candidates in this batch, do NOT echo phrases between assessments.

Return a JSON ARRAY with one entry per candidate, in the SAME ORDER as the candidates appear below. Each entry must include a "candidate_id" field matching the candidate's id attribute, plus all the fields from the scoring schema.

<candidates>
${candidatesBlock}
</candidates>`;

console.log("════════════════════ SYSTEM PROMPT (cached) ════════════════════\n");
console.log(systemInstructions);
console.log("\n════════════════════ USER PROMPT ════════════════════\n");
console.log(userPrompt);
console.log(`\n════════════════════ SIZES ════════════════════
System: ${systemInstructions.length.toLocaleString()} chars (~${Math.round(systemInstructions.length / 4).toLocaleString()} tokens)
User:   ${userPrompt.length.toLocaleString()} chars (~${Math.round(userPrompt.length / 4).toLocaleString()} tokens)
Total:  ${(systemInstructions.length + userPrompt.length).toLocaleString()} chars (~${Math.round((systemInstructions.length + userPrompt.length) / 4).toLocaleString()} tokens)`);
