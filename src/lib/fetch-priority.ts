import type { ParsedRole } from "./ai";
import type { SearchResult } from "./search";
import { isExplicitlyOverseasLocation, isNzLocation } from "./location";
import {
  extractSignalsFromRequirement,
  normalizeSignalText,
  signalMatchesText,
} from "./requirement-signals";

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

function clamp(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function norm(value: string) {
  return normalizeSignalText(value);
}

function textHasTerm(value: string, term: string) {
  return signalMatchesText(value, term);
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
  const terms = requirements.flatMap((requirement) => extractSignalsFromRequirement(requirement));
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
  isRemote?: boolean;
}): FetchPriorityResult {
  const { result, parsedRole, candidateLocation, profileText, isFromTalentPool = false, isRemote = false } = args;
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
    // Soft penalty — when anchor terms or req terms are present, title is a weak signal.
    // -8 was too harsh for roles with variable job titles (QA → Performance Tester etc.)
    score -= 3;
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

  // Anchor-term check: hard penalty if the candidate is missing most anchor terms,
  // bonus if all are present. Anchors are the rare/specific skills that define the role.
  const anchorTerms = (args.parsedRole?.anchor_terms ?? []).filter(Boolean);
  if (anchorTerms.length > 0) {
    const matchedAnchors = anchorTerms.filter((term) => textHasTerm(searchable, term));
    const anchorRatio = matchedAnchors.length / anchorTerms.length;
    if (anchorRatio === 1) {
      score += 8;
      signals.push(`All ${anchorTerms.length} anchor term(s) found: ${matchedAnchors.slice(0, 3).join(", ")}`);
    } else if (anchorRatio < 0.5) {
      score -= 25;
      risks.push(`Missing ${anchorTerms.length - matchedAnchors.length} of ${anchorTerms.length} anchor terms`);
    }
    // ratio 0.5–1.0 = neutral (partial match, no bonus or penalty)
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
    // No location in snippet — moderate penalty for non-remote roles.
    // -20 was too aggressive for small markets like NZ where many LinkedIn
    // profiles don't surface location in the SerpAPI snippet. The overseas
    // text scan below catches confirmed offshore signals separately (-25).
    const noLocPenalty = isRemote ? -6 : -8;
    score += noLocPenalty;
    risks.push("No location signal — could be overseas");
  }

  // Scan full searchable text for US/AU geographic signals even when no explicit location field.
  // Catches "Senior Developer at PNC, Pittsburgh PA" type headlines.
  if (!loc) {
    const fullText = [result.headline, result.snippet, result.matchedQuery].filter(Boolean).join(" ");
    if (isExplicitlyOverseasLocation(fullText)) {
      score -= 25;
      risks.push("Overseas geographic signal detected in profile text");
    }
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
