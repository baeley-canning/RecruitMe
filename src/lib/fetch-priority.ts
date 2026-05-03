import type { ParsedRole } from "./ai";
import type { SearchResult } from "./search";
import { isExplicitlyOverseasLocation, isNzLocation } from "./location";

export interface FetchPriorityReason {
  label: "Strong lead" | "Worth fetching" | "Possible lead" | "Weak lead";
  summary: string;
  signals: string[];
  risks: string[];
  matchedTerms: string[];
}

export interface FetchPriorityResult {
  score: number;
  reason: FetchPriorityReason;
}

const ROLE_STOP_WORDS = new Set([
  "and", "the", "for", "with", "from", "role", "senior", "junior", "lead",
  "principal", "manager", "developer", "engineer", "specialist", "analyst",
  "consultant", "officer", "coordinator", "administrator", "experience",
]);

const REQUIREMENT_ALIASES: Array<[RegExp, string[]]> = [
  [/\bc\+\+/i, ["C++"]],
  [/\.net|asp\.net|c#/i, [".NET", "C#"]],
  [/\bjava\b/i, ["Java"]],
  [/\bjavascript\b|\bjs\b/i, ["JavaScript", "JS"]],
  [/\btypescript\b/i, ["TypeScript"]],
  [/\breact\b/i, ["React"]],
  [/\bangular\b/i, ["Angular"]],
  [/\bvue\b/i, ["Vue"]],
  [/\bnode\b/i, ["Node"]],
  [/\bpython\b/i, ["Python"]],
  [/\bruby\b|\brails\b/i, ["Ruby", "Rails"]],
  [/\bphp\b/i, ["PHP"]],
  [/\bwordpress\b|\bcms\b|content management system/i, ["WordPress", "CMS"]],
  [/\bshopify\b/i, ["Shopify"]],
  [/\bsquarespace\b/i, ["Squarespace"]],
  [/\bsybase\b/i, ["Sybase"]],
  [/\bsql server\b/i, ["SQL Server"]],
  [/\bdb2\b/i, ["DB2"]],
  [/\boracle\b/i, ["Oracle"]],
  [/\bazure\b/i, ["Azure"]],
  [/\baws\b|amazon web services/i, ["AWS"]],
  [/\bgcp\b|google cloud/i, ["GCP"]],
  [/\blinux\b/i, ["Linux"]],
  [/\bkubernetes\b|\baks\b|\beks\b/i, ["Kubernetes"]],
  [/\bdocker\b|container/i, ["Docker"]],
  [/\bmicroservices?\b/i, ["microservices"]],
  [/\bapi\b|api design/i, ["API"]],
  [/\bperformance test|load test|jmeter|loadrunner|gatling/i, ["performance testing", "JMeter", "LoadRunner"]],
  [/\bitil\b|\bitsm\b|service management/i, ["ITIL", "ITSM"]],
  [/security clearance|secret vetting|confidential vetting|\bsv\b|\bcv\b/i, ["security clearance", "Secret Vetting"]],
  [/\bux\b|user experience/i, ["UX", "user experience"]],
  [/web design|digital design|ui\/ux/i, ["web design", "UI/UX"]],
  [/\bbanking\b|payments?|financial services|fintech/i, ["banking", "payments", "financial services"]],
];

function clamp(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function norm(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9+#.]+/g, " ").replace(/\s+/g, " ").trim();
}

function textHasTerm(value: string, term: string) {
  if (term === "C++") return /\bc\+\+/i.test(value);
  if (term === ".NET") return /\.net|asp\.net/i.test(value);
  if (term === "C#") return /\bc#/i.test(value);
  return norm(value).includes(norm(term));
}

function compactTerms(values: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = norm(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function titleTerms(parsedRole: ParsedRole) {
  const raw = [
    parsedRole.title,
    ...(parsedRole.synonym_titles ?? []),
  ].join(" ");
  return compactTerms(
    raw
      .split(/[^a-zA-Z0-9+#.]+/)
      .map((term) => term.trim())
      .filter((term) => term.length >= 3 && !ROLE_STOP_WORDS.has(term.toLowerCase()))
  ).slice(0, 8);
}

function requirementTerms(parsedRole: ParsedRole) {
  const requirements = [
    ...(parsedRole.must_haves ?? []),
    ...(parsedRole.skills_required ?? []),
    ...(parsedRole.knockout_criteria ?? []),
  ];
  const terms: string[] = [];
  for (const requirement of requirements) {
    for (const [pattern, aliases] of REQUIREMENT_ALIASES) {
      if (pattern.test(requirement)) terms.push(...aliases);
    }
  }
  return compactTerms(terms).slice(0, 10);
}

function looksJuniorForSeniorRole(text: string, parsedRole: ParsedRole) {
  const wanted = (parsedRole.seniority_band ?? "").toLowerCase();
  if (!/(mid|senior|lead|principal|manager|director|executive)/.test(wanted)) return false;
  return /\b(junior|graduate|intern|internship|trainee|student|entry level|entry-level|bootcamp|academy|dev academy|seeking entry level|seeking entry-level)\b/i.test(text);
}

function sourceLabel(source: SearchResult["source"]) {
  if (source === "pdl") return "PDL profile data";
  if (source === "bing") return "Bing LinkedIn result";
  return "Google LinkedIn result";
}

function labelFor(score: number): FetchPriorityReason["label"] {
  if (score >= 80) return "Strong lead";
  if (score >= 65) return "Worth fetching";
  if (score >= 50) return "Possible lead";
  return "Weak lead";
}

export function computeFetchPriority(args: {
  result: SearchResult;
  parsedRole: ParsedRole;
  candidateLocation?: string | null;
  profileText?: string | null;
  isFromTalentPool?: boolean;
}): FetchPriorityResult {
  const { result, parsedRole, candidateLocation, profileText, isFromTalentPool = false } = args;
  const searchable = [
    result.name,
    result.headline,
    candidateLocation ?? result.location,
    result.snippet,
    result.matchedQuery,
    profileText ?? result.fullText,
  ].filter(Boolean).join("\n");

  const signals: string[] = [];
  const risks: string[] = [];
  let score = 25;

  if (isFromTalentPool || profileText || result.fullText) {
    score += 24;
    signals.push(isFromTalentPool ? "Existing captured profile available" : "Richer profile data available");
  } else if ((result.snippet ?? "").length >= 120) {
    score += 8;
    signals.push("Search snippet has enough text to inspect");
  } else {
    score -= 6;
    risks.push("Very short search snippet");
  }

  score += result.source === "pdl" ? 10 : 6;
  signals.push(sourceLabel(result.source));

  const roleTerms = titleTerms(parsedRole);
  const matchedTitleTerms = roleTerms.filter((term) => textHasTerm(`${result.headline} ${result.matchedQuery ?? ""}`, term));
  if (matchedTitleTerms.length >= 2) {
    score += 18;
    signals.push(`Role/title terms match: ${matchedTitleTerms.slice(0, 3).join(", ")}`);
  } else if (matchedTitleTerms.length === 1) {
    score += 10;
    signals.push(`Role/title term matches: ${matchedTitleTerms[0]}`);
  } else {
    score -= 8;
    risks.push("Headline does not clearly match the role family");
  }

  const reqTerms = requirementTerms(parsedRole);
  const matchedRequirementTerms = reqTerms.filter((term) => textHasTerm(searchable, term));
  if (reqTerms.length > 0) {
    const ratio = matchedRequirementTerms.length / reqTerms.length;
    score += Math.min(24, matchedRequirementTerms.length * 8);
    if (matchedRequirementTerms.length > 0) {
      signals.push(`Must-have evidence in snippet/query: ${matchedRequirementTerms.slice(0, 4).join(", ")}`);
    }
    if (matchedRequirementTerms.length >= 2) {
      score += 4;
    }
    if (ratio < 0.25) {
      score -= 12;
      risks.push("Few must-have terms visible before fetching");
    }
  } else {
    score += 6;
    signals.push("General role without rare hard-skill anchors");
  }

  const loc = candidateLocation ?? result.location ?? "";
  if (loc) {
    if (isExplicitlyOverseasLocation(loc)) {
      score -= 35;
      risks.push(`Likely out-of-area location: ${loc}`);
    } else if (isNzLocation(loc)) {
      score += 12;
      signals.push(`Compatible location signal: ${loc}`);
    } else {
      score += 5;
      signals.push(`Location present: ${loc}`);
    }
  } else {
    score -= 6;
    risks.push("No location signal in search result");
  }

  if (result.matchedQuery) {
    const queryMatchesReq = reqTerms.filter((term) => textHasTerm(result.matchedQuery ?? "", term));
    if (queryMatchesReq.length > 0) {
      score += 8;
      signals.push(`Matched a high-intent query: ${result.matchedQuery}`);
    }
  }

  if (looksJuniorForSeniorRole(`${result.headline} ${result.snippet}`, parsedRole)) {
    score -= 35;
    risks.push("Junior/graduate signal conflicts with role seniority");
  }

  if (/\b(recruiter|recruitment consultant|talent acquisition|hiring|course|training provider)\b/i.test(`${result.headline} ${result.snippet}`)) {
    score -= 18;
    risks.push("Possible recruiter/training noise");
  }

  const finalScore = clamp(score);
  const label = labelFor(finalScore);
  return {
    score: finalScore,
    reason: {
      label,
      summary:
        label === "Strong lead"
          ? "High-priority lead to fetch; search evidence is strong, but fit still needs full-profile confirmation."
          : label === "Worth fetching"
            ? "Likely worth fetching before judging the actual candidate fit."
            : label === "Possible lead"
              ? "Some useful signals, but fetch only after stronger leads."
              : "Weak initial search hit; do not treat as a strong candidate without more evidence.",
      signals: signals.slice(0, 5),
      risks: risks.slice(0, 4),
      matchedTerms: compactTerms([...matchedTitleTerms, ...matchedRequirementTerms]).slice(0, 8),
    },
  };
}

export function serialiseFetchPriority(reason: FetchPriorityReason) {
  return JSON.stringify(reason);
}
