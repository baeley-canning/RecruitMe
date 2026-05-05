import { chat, withRetry, parseJson, SONNET } from "./chat";
import {
  buildScoreBreakdown,
  CATEGORY_WEIGHTS_V2,
  type ScoreBreakdown,
  type MustHaveStatus,
  type NiceToHaveStatus,
  type CategoryScore,
} from "../scoring";
import {
  buildRequirementAwareProfileExcerpt,
  buildProfileExcerpt,
  SCORE_PROFILE_EXCERPT_MAX_CHARS,
  ACCEPTANCE_PROFILE_EXCERPT_MAX_CHARS,
} from "../profile-excerpt";
import { inferSecurityClearanceContext } from "../security-clearance";
import type { ScoringWeights } from "../scoring-config";
import type { ParsedRole } from "./parsing";

export type { ScoreBreakdown } from "../scoring";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface AcceptanceSignal {
  label: string;
  positive: boolean;
}

export interface AcceptancePrediction {
  score: number;
  likelihood: "high" | "medium" | "low";
  headline: string;
  signals: AcceptanceSignal[];
  summary: string;
}

// ─── Private helpers ───────────────────────────────────────────────────────────

function normalizeCoverageKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function findCoverageMatch<T extends { requirement: string }>(
  expectedRequirement: string,
  items: T[],
  usedIndexes: Set<number>
): T | null {
  const expectedKey = normalizeCoverageKey(expectedRequirement);
  let looseIndex = -1;

  for (let index = 0; index < items.length; index += 1) {
    if (usedIndexes.has(index)) continue;
    const candidateKey = normalizeCoverageKey(items[index].requirement);
    if (!candidateKey) continue;
    if (candidateKey === expectedKey) {
      usedIndexes.add(index);
      return items[index];
    }
    if (looseIndex === -1 && (candidateKey.includes(expectedKey) || expectedKey.includes(candidateKey))) {
      looseIndex = index;
    }
  }

  if (looseIndex !== -1) {
    usedIndexes.add(looseIndex);
    return items[looseIndex];
  }

  return null;
}

// ─── AI functions ──────────────────────────────────────────────────────────────

export async function predictAcceptance(
  profileText: string,
  parsedRole: ParsedRole,
  salary?: { min: number; max: number } | null
): Promise<AcceptancePrediction> {
  if (!profileText || profileText.trim().length < 100) {
    throw new Error("Profile text too short to predict acceptance");
  }
  const profileSlice = buildProfileExcerpt(profileText, ACCEPTANCE_PROFILE_EXCERPT_MAX_CHARS);
  const salaryLine = salary?.min || salary?.max
    ? `Salary offered: $${((salary.min || 0) / 1000).toFixed(0)}k–$${((salary.max || 0) / 1000).toFixed(0)}k NZD/year`
    : "";

  const text = await chat(`You are a senior recruitment consultant estimating whether a candidate is likely to accept a job offer.

Role being offered:
Title: ${parsedRole.title}
Location: ${parsedRole.location}
Experience required: ${parsedRole.experience}
${salaryLine}

Candidate profile:
${profileSlice}

Assess using only evidence in the profile. Consider: tenure in current role, career momentum, job mobility history, salary uplift, title step up/lateral/down, location friction, company instability signals, bio language.

Return ONLY valid JSON (no markdown):
{"score":68,"likelihood":"medium","headline":"3 years without visible promotion — likely open to the right move","signals":[{"label":"3 years in current role — within typical move window","positive":true}],"summary":"2-3 sentence recruiter assessment."}

Score: 70-100 high, 40-69 medium, 0-39 low. Max 5 signals. Only include signals with actual evidence.
Only produce a salary signal if the profile explicitly mentions compensation expectations or a counter-offer situation — do not estimate salary fit from role title alone.`, 0.1, 2048, { model: SONNET });

  const parsed = parseJson<Partial<AcceptancePrediction>>(text);
  const clamp  = (v: unknown) => typeof v === "number" ? Math.min(100, Math.max(0, Math.round(v))) : 50;

  const rawLikelihood = parsed.likelihood;
  const likelihood: "high" | "medium" | "low" =
    rawLikelihood === "high" || rawLikelihood === "medium" || rawLikelihood === "low"
      ? rawLikelihood : "medium";

  return {
    score:     clamp(parsed.score),
    likelihood,
    headline:  parsed.headline ?? "",
    signals:   Array.isArray(parsed.signals)
      ? parsed.signals
          .filter((s): s is AcceptanceSignal => typeof s === "object" && s !== null && typeof s.label === "string")
          .slice(0, 5)
      : [],
    summary: parsed.summary ?? "",
  };
}

export async function scoreCandidateStructured(
  profileText: string,
  parsedRole: ParsedRole,
  salary?: { min: number; max: number } | null,
  weights?: ScoringWeights
): Promise<ScoreBreakdown> {
  if (!profileText || profileText.trim().length < 100) {
    throw new Error("Profile text too short to score");
  }
  const clamp = (v: unknown, fallback = 50) =>
    typeof v === "number" ? Math.min(100, Math.max(0, Math.round(v))) : fallback;

  const baseMustHaves = (parsedRole.must_haves?.length ? parsedRole.must_haves : parsedRole.skills_required);
  const niceToHaves   = (parsedRole.nice_to_haves?.length ? parsedRole.nice_to_haves : parsedRole.skills_preferred).slice(0, 6);
  const knockouts     = parsedRole.knockout_criteria ?? [];
  const clearanceContext = inferSecurityClearanceContext({
    title: parsedRole.title,
    company: parsedRole.company,
    responsibilities: parsedRole.responsibilities,
    explicitlyStated: parsedRole.explicitly_stated,
    stronglyInferred: parsedRole.strongly_inferred,
  });

  // Ensure knockout criteria appear in must_have_coverage. They're binary gates but often
  // land only in knockout_criteria (not must_haves) when parsed. Merge any that aren't
  // already covered so Claude produces a per-item verdict for each one.
  const knockoutsNotInMustHaves = knockouts.filter((ko) =>
    !baseMustHaves.some((mh) => mh.toLowerCase().includes(ko.toLowerCase().slice(0, 25)))
  );
  const mustHaves = [...baseMustHaves, ...knockoutsNotInMustHaves].slice(0, 14);

  const salaryLine    = salary?.min || salary?.max
    ? `Budget: $${((salary.min || 0) / 1000).toFixed(0)}k–$${((salary.max || 0) / 1000).toFixed(0)}k NZD` : "";
  const seniorityLine = parsedRole.seniority_band ? `Seniority: ${parsedRole.seniority_band}` : "";
  const knockoutLine  = knockouts.length ? `Knockout criteria (instant fail if clearly absent): ${knockouts.join("; ")}` : "";
  const clearanceLine = clearanceContext.explicit || clearanceContext.inferred
    ? `Security clearance context: ${
        clearanceContext.explicit
          ? "The role explicitly requires security clearance or clearance eligibility. Assess only from evidence; absence is missing/unknown, not confirmed."
          : "The role is likely clearance-sensitive based on employer/title, but clearance is not explicit. Treat prior government, defence, border, justice, police, intelligence, or security-vetted supplier work as a positive signal; do not fail candidates solely for no clearance evidence."
      }`
    : "";
  const mustHavesList = mustHaves.map((m, i) => `${i + 1}. ${m}`).join("\n");
  const niceList      = niceToHaves.map((n, i) => `${i + 1}. ${n}`).join("\n");

  const profileSlice = buildRequirementAwareProfileExcerpt(
    profileText,
    SCORE_PROFILE_EXCERPT_MAX_CHARS,
    [...mustHaves, ...niceToHaves]
  );

  const text = await chat(
    `You are a senior recruitment consultant scoring a candidate against a specific role. Return ONLY compact JSON — no markdown, no newlines inside string values.

Role: ${parsedRole.title} | ${parsedRole.location}${salaryLine ? ` | ${salaryLine}` : ""}${seniorityLine ? ` | ${seniorityLine}` : ""}

Must-haves (numbered — include ALL in must_have_coverage):
${mustHavesList}

Nice-to-haves (numbered — include ALL in nice_to_have_coverage):
${niceList || "(none listed)"}
${knockoutLine}
${clearanceLine}

Candidate profile:
${profileSlice}

Return EXACTLY this JSON structure:
{
  "categories": {
    "skill_fit":        {"score":0,"evidence":"one sentence grounding the score in actual profile text"},
    "location_fit":     {"score":0,"evidence":"one sentence"},
    "seniority_fit":    {"score":0,"evidence":"one sentence"},
    "title_fit":        {"score":0,"evidence":"one sentence"},
    "domain_fit":       {"score":0,"evidence":"one sentence covering both sector/domain experience AND vocabulary alignment"},
    "nice_to_have_fit": {"score":0,"evidence":"one sentence about how many nice-to-haves are present"}
  },
  "must_have_coverage": [
    {"requirement":"exact text from must-haves list","status":"confirmed|equivalent|likely|likely_historical|missing|negative|unknown","evidence":"direct quote or paraphrase from profile, or Not mentioned"}
  ],
  "nice_to_have_coverage": [
    {"requirement":"exact text from nice-to-haves list","status":"confirmed|likely|absent","evidence":"direct quote or paraphrase, or Not mentioned"}
  ],
  "reasons_for": ["specific positive signal from the profile","..."],
  "reasons_against": ["specific concern or gap from the profile","..."],
  "missing_evidence": ["specific fact that would change the score if known","..."],
  "recruiter_summary": "One sentence only. The single most important fact about fit or gap — name something specific from this profile (a skill, job title, company, or year count). Must not repeat anything already listed in reasons_for or reasons_against. If a strong match, say why in one line. If there is a blocker, name it."
}

Category score rules:
- skill_fit: 80+ = most must-have skills confirmed; 60-79 = several confirmed; 40-59 = adjacent; 0-39 = mismatch
- location_fit: 100 = same city/region; 80 = commutable; 50 = same country; 0 = overseas
- seniority_fit: 100 = exact match; 70 = one level off; 40 = two levels off; 0 = completely wrong level
- title_fit: do recent titles align with how people in this role describe themselves on LinkedIn?
- domain_fit: assess BOTH sector/domain experience AND vocabulary alignment together. 80+ = candidate's sector matches the role AND their language aligns with how this industry describes itself; 60-79 = good on one dimension but not both; 40-59 = adjacent domain; 0-39 = unrelated field
- nice_to_have_fit: 80+ = most nice-to-haves present; 50 = some; 20 = few; if none listed, score 50

must_have_coverage rules:
- "confirmed" = clearly and explicitly stated in the profile
- "equivalent" = requirement uses an equivalency clause ("or equivalent experience", "or comparable experience", "preferred but not essential") AND the candidate's experience is sufficient to satisfy it — use the thresholds in the equivalency rules below
- "likely" = strongly implied by adjacent evidence (e.g. a company or framework implies a skill); also use for partial equivalency where experience is present but not clearly sufficient
- "likely_historical" = the skill clearly appears in PAST work history (typically a previous role, 3+ years ago) BUT the candidate's current and recent roles show they have moved to a clearly different primary technology or domain. The skill is real and verifiable; the concern is recency and active use. Use this when a C++ developer is now exclusively doing C#, a Java engineer has spent 5 years in Python, etc. Do NOT use for general seniority or domain drift — only when the specific technology has been replaced by something else.
- "missing" = not mentioned AND no equivalency route applies — could have it but unverifiable
- "negative" = profile actively contradicts this requirement (e.g. no work rights, wrong country, degree stated in a completely unrelated field)
- "unknown" = insufficient data to make any assessment
- Include EXACTLY one entry per must-have. Do not skip or merge any.${knockouts.length ? `
- If any knockout criterion is failed, status must be "negative".` : ""}
- Grouped requirement rule: if a must-have starts with "At least half of:" or similar partial-coverage phrasing, assess the candidate holistically against the whole list. "confirmed" = meets or exceeds the stated threshold; "likely" = one item short of the threshold or meets it via adjacent skills; "missing" = clearly below the threshold; "unknown" = cannot assess from available data.
- Historical experience rule: scan the FULL work history, not just the current or recent role. A skill that appears in an older role counts as at minimum "likely" — the candidate has demonstrably used it. Only mark "missing" if the skill appears nowhere in the entire profile. However: if a skill appears only in past roles AND the candidate's current/recent work is clearly a different primary technology (e.g. was a C++ developer, is now exclusively C#/.NET; was a Java engineer, now only Python), use "likely_historical" rather than "likely" to signal the skill is real but not current. Use plain "likely" when the historical skill is still plausibly in use or when the candidate's overall stack suggests continuity.
- Career-stage awareness: if a candidate has moved from a hands-on technical role to a management/leadership role, note this as a concern in reasons_against (e.g. "Has moved away from hands-on X development") rather than falsely stating the skill is absent. The skill history is real; the concern is recency and focus, not absence.
- Security clearance inference: do not invent an active clearance. If clearance is explicit, "confirmed" requires direct profile evidence of clearance or a role/employer where clearance is normally mandatory; "likely" can be used for recent NZ defence, intelligence, police, corrections, customs, border, justice, or vetted government supplier work; otherwise use "unknown" or "missing". If clearance is only inferred from the role context, mention this under nice-to-have/industry fit and missing_evidence rather than treating it as an automatic fail.

nice_to_have_coverage rules:
- "confirmed" = explicitly present; "likely" = implied; "absent" = not present or not mentioned
- Include EXACTLY one entry per nice-to-have. If no nice-to-haves were listed, return empty array.

reasons_for: 2–4 specific, evidenced positive signals. Not generic praise. Reference actual job titles, companies, skills from the profile. Include historical experience where relevant.
reasons_against: 2–4 specific concerns grounded in the profile. Do NOT claim a skill is absent if it appears anywhere in the work history — instead note recency concerns (e.g. "Sybase experience is from 2011; role may require current hands-on use"). Do not speculate beyond what the profile shows.
missing_evidence: 2–4 specific facts that are NOT in the profile and would materially change the score (e.g. "Years in role not stated", "No mention of team leadership despite Senior title").

Short snippet rule: if the profile is a short snippet (under ~500 chars), treat unmentioned skills as genuinely unknown — do NOT assume they are present. Mark them "missing" or "unknown" accordingly. A snippet that does not mention WordPress does not confirm WordPress. Score only what is explicitly evidenced. Location and title alone should not carry a weak profile into 60%+ territory.

Degree/qualification rules: when a must-have specifies a degree or qualification, assess BOTH level and field relevance.
- "confirmed" = candidate explicitly states a degree in the required field or a directly equivalent field (e.g. CS degree for software role, Accounting degree for accountant role, Nursing degree for nursing role).
- "likely" = candidate has a degree in an adjacent field (e.g. IT degree for CS role, Finance degree for Accounting role, or strong industry signals implying relevant education).
- "missing" = profile gives no education information for a role where a degree is required.
- "negative" = profile explicitly states a degree in a clearly unrelated field with no bridging evidence.
Do NOT mark as "confirmed" just because a candidate has a degree — the field must align with what the role requires.

Education-based skill inference: when assessing must-have SKILLS (not qualifications), use the candidate's degree/diploma to infer curriculum-core skills as "likely" — even if those skills aren't listed explicitly. Apply this inference only for skills that are standard curriculum content for that qualification:
- Software development diploma or degree → front-end web (HTML, CSS, JavaScript), basic back-end, version control (Git), databases. NOT web design, UX, or specific CMS platforms like WordPress unless explicitly stated.
- Computer Science degree → algorithms, data structures, general programming. NOT specific frameworks unless stack is mentioned.
- Accounting/Finance degree → financial reporting, Excel, bookkeeping. NOT specific accounting software unless mentioned.
- Design degree (graphic/visual/UX) → Figma/Adobe tools, visual hierarchy, UX principles. NOT front-end coding unless explicitly stated.
The inference only goes as far as the standard curriculum — a software dev diploma does not confirm WordPress, UX design, or video editing. Do NOT over-infer: use "likely" conservatively and only for the core technical skills the qualification is known to teach.

Equivalency clause rules: when a must-have requirement contains "or equivalent experience", "or comparable experience", "preferred but not essential", "beneficial but not required", or similar flexibility language, do NOT treat it as a hard degree gate. Instead, judge whether the candidate's directly relevant experience satisfies the clause:
- 0–2 years relevant experience → "missing" (insufficient, equivalency not met)
- 3–4 years adjacent experience → "likely" (partial equivalency, use with a note that it may satisfy)
- 5–7 years strong, directly relevant experience → "equivalent" (satisfies the clause — note this in evidence)
- 8+ years directly relevant experience, or senior-level titles in the same domain → "equivalent" with high confidence
The evidence string MUST explain HOW the equivalency is met: e.g. "11 years as IT Systems Administrator satisfies 'degree or equivalent experience' clause" — not just "has experience".
IMPORTANT CARVE-OUTS — do NOT apply experience equivalency to requirements involving:
- Professional registration (Registered Nurse, Chartered Accountant, Licensed Electrician, Engineer NZ, solicitor)
- Legal compliance requirements (NZ work rights, security clearances, mandatory licences)
- Roles where formal accreditation is a legal prerequisite for practice
For these, equivalency does not apply. If no formal qualification is stated, mark "unknown" or "missing" as appropriate.
Do NOT let seniority in an unrelated domain satisfy the clause. A senior accountant's experience does not satisfy "engineering degree or equivalent experience." Domain must match.`,
    0.1,
    4096,
    { model: SONNET }
  );

  type RawCat = { score?: number; evidence?: string };
  type RawAI = {
    categories?: {
      skill_fit?:        RawCat;
      location_fit?:     RawCat;
      seniority_fit?:    RawCat;
      title_fit?:        RawCat;
      domain_fit?:       RawCat;
      nice_to_have_fit?: RawCat;
    };
    must_have_coverage?:   Array<{ requirement?: string; status?: string; evidence?: string }>;
    nice_to_have_coverage?: Array<{ requirement?: string; status?: string; evidence?: string }>;
    reasons_for?:     string[];
    reasons_against?: string[];
    missing_evidence?: string[];
    recruiter_summary?: string;
  };

  const raw = parseJson<RawAI>(text);

  const parseCategory = (key: keyof NonNullable<RawAI["categories"]>, weight: number): CategoryScore => ({
    score:    clamp(raw.categories?.[key]?.score),
    weight,
    evidence: typeof raw.categories?.[key]?.evidence === "string" ? raw.categories[key]!.evidence : "",
  });

  const validMH  = new Set(["confirmed", "equivalent", "likely", "missing", "negative", "unknown"]);
  const validNTH = new Set(["confirmed", "likely", "absent"]);

  const rawMustHaveCoverage: MustHaveStatus[] = (raw.must_have_coverage ?? [])
    .filter((c) => typeof c?.requirement === "string" && typeof c?.status === "string")
    .map((c) => ({
      requirement: c.requirement!,
      status:      validMH.has(c.status!) ? (c.status as MustHaveStatus["status"]) : "unknown",
      evidence:    typeof c.evidence === "string" ? c.evidence : "Not mentioned",
    }));

  const rawNiceToHaveCoverage: NiceToHaveStatus[] = (raw.nice_to_have_coverage ?? [])
    .filter((c) => typeof c?.requirement === "string" && typeof c?.status === "string")
    .map((c) => ({
      requirement: c.requirement!,
      status:      validNTH.has(c.status!) ? (c.status as NiceToHaveStatus["status"]) : "absent",
      evidence:    typeof c.evidence === "string" ? c.evidence : "Not mentioned",
    }));

  const usedMustHaveIndexes = new Set<number>();
  const mustHaveCoverage: MustHaveStatus[] = mustHaves.map((requirement) => {
    const match = findCoverageMatch(requirement, rawMustHaveCoverage, usedMustHaveIndexes);
    if (match) {
      return {
        requirement,
        status: match.status,
        evidence: match.evidence,
      };
    }
    return {
      requirement,
      status: "unknown",
      evidence: "No coverage returned by model for this must-have.",
    };
  });

  const usedNiceToHaveIndexes = new Set<number>();
  const niceToHaveCoverage: NiceToHaveStatus[] = niceToHaves.map((requirement) => {
    const match = findCoverageMatch(requirement, rawNiceToHaveCoverage, usedNiceToHaveIndexes);
    if (match) {
      return {
        requirement,
        status: match.status,
        evidence: match.evidence,
      };
    }
    return {
      requirement,
      status: "absent",
      evidence: "No coverage returned by model for this nice-to-have.",
    };
  });

  const stringArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];

  const categories: ScoreBreakdown["categories"] = {
    skill_fit:        parseCategory("skill_fit",        weights?.skill_fit ?? CATEGORY_WEIGHTS_V2.skill_fit),
    location_fit:     parseCategory("location_fit",     weights?.location_fit ?? CATEGORY_WEIGHTS_V2.location_fit),
    seniority_fit:    parseCategory("seniority_fit",    weights?.seniority_fit ?? CATEGORY_WEIGHTS_V2.seniority_fit),
    title_fit:        parseCategory("title_fit",        weights?.title_fit ?? CATEGORY_WEIGHTS_V2.title_fit),
    domain_fit:       parseCategory("domain_fit",       weights?.domain_fit ?? CATEGORY_WEIGHTS_V2.domain_fit),
    nice_to_have_fit: parseCategory("nice_to_have_fit", weights?.nice_to_have_fit ?? CATEGORY_WEIGHTS_V2.nice_to_have_fit),
  };

  return buildScoreBreakdown({
    categories,
    must_have_coverage:    mustHaveCoverage,
    nice_to_have_coverage: niceToHaveCoverage,
    reasons_for:           stringArray(raw.reasons_for),
    reasons_against:       stringArray(raw.reasons_against),
    missing_evidence:      stringArray(raw.missing_evidence),
    recruiter_summary:     typeof raw.recruiter_summary === "string" ? raw.recruiter_summary : "",
    profileCharCount:      profileText.length,
    weights,
  });
}
