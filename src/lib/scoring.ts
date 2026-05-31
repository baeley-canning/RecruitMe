// ─── Structured scoring types and pure functions ───────────────────────────────
// No AI, no DB, no side effects — everything here is deterministic.
// The AI populates raw category scores + coverage + reasons.
// These functions compute overall, pcts, evidence coverage, and confidence.
//
// v2 → v3 changelog:
//   - Must-have weight raised from 0.28 → 0.36 (skills over location)
//   - Location weight cut from 0.14 → 0.08
//   - Seniority weight cut from 0.14 → 0.10
//   - Snippet point table: missing=5, unknown=30, likely=55 (unknown raised from 15 — absence of evidence ≠ absence)
//   - Per-requirement importance weights (WordPress/CMS/RightToWork = 1.5×)
//   - Degree importance weights: regulated profession=1.5×, technical field degree=1.3×, general degree=1.1×
//   - "equivalent" status: requirement satisfied via experience (full=100, snippet=85, minimal=70); not "unconfirmed"
//   - Critical gate: unconfirmed 1.5× must-have on snippet hard-caps to 45; "equivalent" does not trigger gate
//   - Snippet cap raised from 55 to 70 (snippets are genuinely informative), minimal at 40
//   - Search route applies 30% floor for snippet data so provisional results surface
//   - Search route locationFitScore cutoff only fires when candidateLocation is known
//   - Knockout criteria merged into must_haves for scoring so they affect the coverage score

// ─── Status types ──────────────────────────────────────────────────────────────

export type MustHaveCoverageStatus = "confirmed" | "equivalent" | "likely" | "likely_historical" | "missing" | "negative" | "unknown";
export type NiceToHaveCoverageStatus = "confirmed" | "likely" | "absent";
export type DataQuality = "full_profile" | "snippet" | "minimal";
export type ConfidenceLevel = "high" | "medium" | "low";

export interface ProfileCaptureWarning {
  code: "incomplete_capture";
  message: string;
  evidence: string[];
}

// ─── Evidence item types ───────────────────────────────────────────────────────

export interface MustHaveStatus {
  requirement:  string;
  status:       MustHaveCoverageStatus;
  evidence:     string;
}

export interface NiceToHaveStatus {
  requirement:  string;
  status:       NiceToHaveCoverageStatus;
  evidence:     string;
}

// ─── External weight config (optional — falls back to CATEGORY_WEIGHTS_V2) ─────
export type { ScoringWeights } from "./scoring-config";
import type { ScoringWeights } from "./scoring-config";

// ─── Score structures ──────────────────────────────────────────────────────────

export interface CategoryScore {
  score:    number;
  weight:   number;
  evidence: string;
}

export interface ScoreBreakdown {
  version: 2;
  overall: number;
  evidence_coverage_score: number;
  categories: {
    skill_fit:          CategoryScore;
    location_fit:       CategoryScore;
    seniority_fit:      CategoryScore;
    title_fit:          CategoryScore;
    domain_fit:         CategoryScore;
    nice_to_have_fit:   CategoryScore;
    // Legacy fields — present on old DB records, absent on new ones
    industry_fit?:      CategoryScore;
    keyword_alignment?: CategoryScore;
  };
  must_have_coverage:   MustHaveStatus[];
  must_have_pct:        number;
  nice_to_have_coverage: NiceToHaveStatus[];
  nice_to_have_pct:     number;
  reasons_for:          string[];
  reasons_against:      string[];
  missing_evidence:     string[];
  confidence: {
    level:   ConfidenceLevel;
    score:   number;
    reasons: string[];
  };
  data_quality:      DataQuality;
  profile_capture_warning?: ProfileCaptureWarning;
  recruiter_summary: string;
  /**
   * Which model produced this breakdown. Absent on legacy rows; "claude"
   * for the default pipeline; "ollama" when Claude failed and the local
   * Ollama failover ran. Both providers are first-class — no penalty is
   * applied either way — the field exists so the UI can render a
   * provenance pill.
   */
  scoredBy?: "claude" | "ollama";
}

// ─── Category weights — v3 (must sum to 1.0) ───────────────────────────────────
// Must-have coverage is now 36%: can you do the job matters most.
// Location cut to 8%: being nearby should not carry a weak profile.

export const CATEGORY_WEIGHTS_V2 = {
  skill_fit:        0.22,
  location_fit:     0.08,
  seniority_fit:    0.10,
  title_fit:        0.08,
  domain_fit:       0.10, // replaces industry_fit(0.04) + keyword_alignment(0.06)
  nice_to_have_fit: 0.06,
  // must_have_pct contributes 0.36
} as const;
// Check: 0.22+0.08+0.10+0.08+0.10+0.06 = 0.64; plus must_have_pct*0.36 = 1.00 ✓

export const MUST_HAVE_WEIGHT_V2 = 0.36;

// ─── Point tables ───────────────────────────────────────────────────────────────
// For full profiles: absence is a real zero.
// For snippets: "missing" and "unknown" mean "not yet proven" — very low credit.
// "likely" is still worth something, but not a free ride.

const MUST_HAVE_POINTS_BY_QUALITY: Record<DataQuality, Record<MustHaveCoverageStatus, number>> = {
  full_profile: {
    confirmed:         100,
    equivalent:        100, // satisfies via experience — treated identically to confirmed
    likely:             50, // lowered from 65: a generous "likely" on a detailed profile shouldn't give 80%+
    likely_historical:  30, // skill is real but not current — candidate has moved to a different stack
    missing:             0,
    negative:            0,
    unknown:             0,
  },
  snippet: {
    confirmed:         100,
    equivalent:         85,
    likely:             55,
    likely_historical:  25,
    // "missing" on a snippet usually means the model couldn't see body text —
    // not that the candidate lacks the skill. Treat as soft-negative, not 0.
    missing:            20,
    negative:            0,
    // "unknown" on a snippet means "could not assess from visible signals" —
    // it's a data-quality gap, not a candidate gap, so contribute neutrally
    // (50) and let other dimensions decide. Without this change, 3 unknown
    // must-haves on a snippet headline-only capture pulled the pct down to
    // ~30 and tanked otherwise-strong candidates (the Microsoft + C++ case).
    unknown:            50,
  },
  minimal: {
    confirmed:         100,
    equivalent:         70,
    likely:             45,
    likely_historical:  20,
    missing:             0,
    negative:            0,
    unknown:            40,
  },
};

const NICE_TO_HAVE_POINTS: Record<NiceToHaveCoverageStatus, number> = {
  confirmed: 100,
  likely:    60,
  absent:    0,
};

// ─── Importance weights ────────────────────────────────────────────────────────
// Per-requirement multiplier derived from the requirement text itself.
// Critical skills that cannot be compensated for by location or title get 1.5×.
// Soft behavioural traits that don't differentiate on their own get 0.7×.

export function getMustHaveImportance(requirement: string): number {
  const r = requirement.toLowerCase();
  // Critical — cannot be compensated for by location or title alone
  if (/wordpress|content management system|\bcms\b/i.test(r))                return 1.5;
  if (/right to work|work rights|nz citizen|nz resident|\bvisa\b|work in new zealand/i.test(r)) return 1.5;
  // Active / held clearance — a real credential that cannot be substituted.
  // Matched first so it wins over the eligibility check below.
  if (/security vetting|secret vetting|confidential vetting|nzsis|national security clearance|baseline clearance|secret clearance|top secret|must hold.*clearance|holds.*clearance|current.*clearance/i.test(r)) return 1.5;
  // "Eligible for security clearance" / "clearance eligibility" phrases mean the candidate
  // must be an NZ citizen or permanent resident — a residency check, not a held credential.
  // That is already captured by the "nz citizen|nz resident" rule above (1.5×) whenever
  // the requirement spells it out. Drop the pure eligibility phrasing to 1.0× so it does
  // not double-penalise candidates who simply haven't listed citizenship on LinkedIn.
  if (/\bsecurity clearance\b/i.test(r) && !/eligible for|eligibility|ability to obtain|must be eligible/i.test(r)) return 1.5;
  // Regulated-profession qualifications: degree is a legal/professional prerequisite
  if (/\b(chartered accountant|cpa|ca qualification|cfa)\b/i.test(r))        return 1.5;
  if (/\b(registered nurse|nursing registration|nzrn|nursing council)\b/i.test(r)) return 1.5;
  if (/\b(engineering degree|civil engineering|structural engineering)\b.*\b(degree|qualification)\b/i.test(r)) return 1.5;
  if (/\b(law degree|llb|legal qualification|bar admission)\b/i.test(r))     return 1.5;
  if (/\b(medical degree|mbchb|mbbs|nzmc registration)\b/i.test(r))         return 1.5;
  // NZ-specific non-delegable licences and practising certificates
  if (/\b(licensed building practitioner|lbp|building practitioner)\b/i.test(r)) return 1.5;
  if (/\b(practising certificate|practicing certificate)\b/i.test(r))        return 1.5;
  if (/\b(real estate licence|real estate license|real estate agent.*licen|rea licen)\b/i.test(r)) return 1.5;
  if (/\b(veterinary registration|nzrv|veterinary council)\b/i.test(r))      return 1.5;
  if (/\b(registered psychologist|psychology registration|nzpb)\b/i.test(r)) return 1.5;
  if (/\b(registered teacher|teacher registration|teaching council)\b/i.test(r)) return 1.5;
  // Technical degrees where field relevance matters
  if (/\b(degree|bachelor|master|phd|doctorate)\b.{0,30}\b(computer science|software|information technology|data science|cybersecurity|electrical engineering)\b/i.test(r)) return 1.3;
  if (/\b(computer science|software engineering|information technology)\b.{0,30}\b(degree|qualification)\b/i.test(r)) return 1.3;
  // General degree requirement — more important than soft skills but field is flexible
  if (/\b(bachelor'?s?\s+degree|master'?s?\s+degree|university degree|tertiary qualification|relevant degree)\b/i.test(r)) return 1.1;
  if (/\bdegree\b|\bdiploma\b/i.test(r) && !/equivalent|or equivalent|preferred/i.test(r)) return 1.1;
  // Very important technical requirements
  if (/\bux\b|user experience|design principle|web design|ux.{0,10}design|design.{0,10}develop/i.test(r)) return 1.3;
  if (/\bperformance test|load test|jmeter|loadrunner|gatling|neoload\b/i.test(r)) return 1.3;
  // Primary/rare technologies — if explicitly required and confirmed missing on a full profile,
  // no amount of location/domain/seniority alignment rescues the candidate.
  if (/\bc\+\+/i.test(r)) return 1.5;
  if (/\bsybase\b|\bcobol\b|\bmainframe\b/i.test(r)) return 1.5; // legacy/rare: absence is a blocker
  // NZ-scarce industrial / compliance specialisms — same scarcity reasoning as
  // legacy DBs. PLC is phrase-anchored to dodge company-suffix collision
  // ("Vodafone PLC"). Keep aligned with NZ_SCARCE_SKILLS in requirement-signals.
  if (/\bscada\b|\brtu\b|programmable\s+logic\s+controller|\bplc\s+(?:programming|integration|configuration|ladder|hmi|scada)/i.test(r)) return 1.5;
  if (/\bisms\b|information\s+security\s+management\s+system|\biso\s*27001\b/i.test(r)) return 1.5;
  if (/\bangular\b|\.net|asp\.net|c#|azure|kubernetes|aks|api design|ci\/cd|pipeline/i.test(r)) return 1.3;
  if (/\bitil\b|\bitsm\b|service management|incident management|change management|problem management|requirements|process mapping|business analysis/i.test(r)) return 1.2;
  if (/concept to launch|full.{0,5}site|full.{0,5}build|full website|ownership|end.to.end/i.test(r)) return 1.2;
  if (/shopify|squarespace|woocommerce/i.test(r))                            return 1.2;
  if (/front.?end|back.?end|full.?stack/i.test(r))                          return 1.1;
  // Soft traits — useful but cannot rescue a weak technical profile
  if (/goal.orient|deadline|desire to learn|attention to detail|collaborate|communication|team/i.test(r)) return 0.7;
  return 1.0;
}

// ─── Pure computation functions ─────────────────────────────────────────────────

export function classifyDataQuality(charCount: number): DataQuality {
  if (charCount >= 2000) return "full_profile";
  if (charCount >= 200)  return "snippet";
  return "minimal";
}

const MONTH_RE = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const YEAR_RANGE_RE = new RegExp(
  `\\b(?:${MONTH_RE}\\s+)?(?:19|20)\\d{2}\\s*(?:[-–—]|to)\\s*(?:(?:${MONTH_RE}\\s+)?(?:19|20)\\d{2}|present|current|now)\\b`,
  "gi",
);
// Section headings as written in LinkedIn captures AND in CV exports.
// CV variants (WORK EXPERIENCE, PROFESSIONAL EXPERIENCE, EMPLOYMENT
// HISTORY, etc.) added after the JobAdder bulk import revealed the gate
// was routing CV-shaped imports to buildStubBreakdown (cap at 50)
// because they don't use LinkedIn's mixed-case single-word headings.
// Trailing terminator broadened from `(?:\n|$)` to `[:\n]` so inline
// "Skills:" / "Education:" patterns common in CVs are also recognised.
const EXPERIENCE_HEADING_RE = /(?:^|\n)\s*(experience|work\s+experience|professional\s+experience|employment\s+history|employment|work\s+history|career\s+history|career\s+summary)\s*[:\n]/i;
const PROFILE_SECTION_HEADING_RE = /(?:^|\n)\s*(about|profile|summary|objective|experience|work\s+experience|professional\s+experience|employment|employment\s+history|work\s+history|career\s+history|career\s+summary|education|qualifications|skills|technical\s+skills|key\s+skills|top\s+skills|core\s+competencies|licenses|certifications|licenses\s+&\s+certifications|references|projects|achievements|languages)\s*[:\n]/i;
// Tier 1 deterministic marker: the scoring prompt instructs Claude to prefix
// recruiter_summary with [CAPTURE_PARTIAL] on partial captures. Detecting the
// marker is robust to all phrasing drift. The legacy phrase patterns below
// remain as a safety net for cases where the model omits the marker — same
// detection behaviour we shipped before, just no longer the primary signal.
const STUB_MARKER_RE = /\[CAPTURE[_ ]PARTIAL\]/i;
const STUB_SIGNAL_RE = /\b(?:near[- ]empty|empty stub|profile (?:is |appears )?(?:a )?stub|no work history|no visible work history|no skills (?:list )?visible|without (?:a )?full cv|do not progress (?:or reject )?without|do not (?:progress|reject) without|insufficient profile|(?:profile|linkedin) capture (?:is |appears )?incomplete|missing work history|capture is incomplete|cannot be (?:fairly )?assessed|visible linkedin data only|directional ranking signal|partial capture)\b/i;

// ─── Deterministic Stage 1: signal presence + sufficiency gate ────────────
//
// Runs BEFORE Claude. Two jobs:
//   (a) Stub gate — when the capture is too thin to score fairly, refuse to
//       call Claude at all. Avoids the "12% with fabricated rejection
//       reasons" failure mode that destroys recruiter trust (cf. Brendan
//       Lester case — full LinkedIn history visible online but the scrape
//       captured only headline + about, which Claude then "scored" as
//       missing every must-have).
//   (b) Ground-truth signal — for must-haves whose tokens ARE present in
//       the profile text via regex match, surface them to Claude as
//       confirmed evidence so it can't contradict them. Means Claude scores
//       PRESENCE + nuance, not absence.

export interface DeterministicMatch {
  /** Must-haves with at least one regex/alias hit in the profile text. */
  matchedSignals: string[];
  /** Must-haves with NO regex/alias hits in the profile text. */
  missingSignals: string[];
  /** Year-range patterns ("1998 – 2001", "2017-present") detected. */
  rolesDetected: number;
  /** Char count of the profile text (post-trim). */
  charCount: number;
  /**
   * Is this capture rich enough to score fairly? The gate that prevents
   * Claude from being asked to fabricate a verdict on absent data.
   *
   * Sufficient when the profile has either (a) full-profile char count AND
   * at least one work-history entry detected, OR (b) at least one role
   * anchor matched. Snippet captures fall through to provisional scoring
   * (handled separately) — this gate is for "we tried to capture a full
   * profile but the scrape failed".
   */
  sufficient: boolean;
  /** Human-readable reason when not sufficient — surfaced to UI/logs. */
  reasonInsufficient?: string;
}

/**
 * Run text-only Stage 1 checks. No AI. Pure deterministic regex over the
 * captured text + the parsed JD must-haves. Cheap (~1ms) and the output is
 * the source of truth that Claude can't contradict downstream.
 *
 * `signalMatchesText` is passed in to avoid coupling scoring.ts to
 * requirement-signals.ts (already imported in plenty of consumers; keeps
 * this function unit-testable in isolation).
 */
// Recently-employed candidates' LinkedIn captures often show "Since 2018"
// or "5 yrs" instead of a YYYY-YYYY range. These also count as work-history
// signals — a current role marker proves the Experience section was actually
// captured. Without recognising them, the gate falsely refuses to score
// real, currently-employed candidates.
const CURRENT_ROLE_RE = /\b(?:since\s+(?:19|20)\d{2}|\d+\s*yrs?\b|\d+\s*mos?\b)/gi;

export function runDeterministicMatch(args: {
  profileText: string;
  mustHaves: string[];
  /** Caller-injected signal expansion + match. Production wires the
   *  requirement-signals.ts implementations; tests inject lightweight
   *  versions to lock specific behaviour. */
  expandSignals: (req: string) => string[];
  matchSignal: (haystack: string, signal: string) => boolean;
}): DeterministicMatch {
  const profileText = args.profileText.trim();
  const charCount = profileText.length;
  const yearRangeHits = (profileText.match(YEAR_RANGE_RE) ?? []).length;
  const currentRoleHits = (profileText.match(CURRENT_ROLE_RE) ?? []).length;
  const rolesDetected = yearRangeHits + currentRoleHits;

  const matched: string[] = [];
  const missing: string[] = [];
  for (const req of args.mustHaves) {
    const signals = args.expandSignals(req);
    const hit = signals.some((s) => args.matchSignal(profileText, s));
    if (hit) matched.push(req);
    else missing.push(req);
  }

  // Sufficient = "we have enough captured text + signal evidence to ask
  // Claude for a fair score". This is intentionally lenient — we only
  // refuse to score when the capture is plainly incomplete (Brendan stub:
  // chars look full but ZERO work entries detected). A genuinely thin
  // junior profile (1 role, 2000+ chars, no must-haves matched) still
  // passes the gate — Claude can read the prose and produce a fair "low
  // match" score. The gate's job is to catch SCRAPE FAILURE, not to
  // pre-judge candidate fit.
  let sufficient = true;
  let reasonInsufficient: string | undefined;
  // Only refuse when ALL of:
  //   - the profile is long enough to look full (≥2000 chars)
  //   - there's at least one must-have to gate on (otherwise we have nothing
  //     to detect by absence)
  //   - no work-history markers detected (no year ranges AND no "since 2018"
  //     / "N yrs" current-role markers)
  //   - none of the must-haves' signals appear in the text
  //   - no LinkedIn structural section markers (about / experience / skills /
  //     education / etc.) — if those are present the scrape worked, the
  //     candidate is just a poor fit and Claude should score them
  const hasAnyMustHaves = args.mustHaves.length > 0;
  const hasStructuralMarkers = PROFILE_SECTION_HEADING_RE.test(profileText) || EXPERIENCE_HEADING_RE.test(profileText);
  if (
    charCount >= 2000 &&
    rolesDetected === 0 &&
    hasAnyMustHaves &&
    matched.length === 0 &&
    !hasStructuralMarkers
  ) {
    sufficient = false;
    reasonInsufficient =
      "Profile is long enough to look like a full capture but contains no detectable work history (no dated roles, no must-have tokens, no LinkedIn section headers). Capture likely failed to expand the Experience section — re-fetch or upload CV before scoring.";
  }

  return {
    matchedSignals: matched,
    missingSignals: missing,
    rolesDetected,
    charCount,
    sufficient,
    reasonInsufficient,
  };
}

/**
 * Build a ScoreBreakdown for the pre-Claude pipeline path when Stage 1
 * couldn't establish enough signal to call Claude meaningfully. We still
 * produce a real score from the visible content (location, headline,
 * seniority) — at sourcing stage the recruiter is ranking candidates to
 * decide who to progress, NOT making a hire decision. Withholding the
 * score hides the candidate; producing a low one with a clear "partial
 * capture" flag lets the recruiter decide.
 *
 * Must-haves the regex couldn't verify are marked "unknown" (NOT
 * "missing") with explanatory evidence. reasons_against stays empty —
 * we never fabricate rejection text from absent data.
 */
export function buildStubBreakdown(args: {
  parsedRoleMustHaves: string[];
  parsedRoleNiceToHaves: string[];
  profileCharCount: number;
  reasonInsufficient: string;
  /** What we CAN see in the captured text — positive signals to score on. */
  visibleSignals?: {
    /** "Lead Engineer - Quality at Xero" — yields seniority + title + employer fit. */
    headline?: string | null;
    /** Wellington, Auckland, etc. — yields location_fit. */
    location?: string | null;
  };
  weights?: ScoringWeights;
}): ScoreBreakdown {
  const visibleSignals = args.visibleSignals ?? {};
  // Score what's visible. Headline + location are usually captured even on
  // partial scrapes. We can't assess skills (must-haves not in capture), so
  // skill/domain stay neutral-low. The result is a directional 30-50% score
  // tagged as low-confidence — the recruiter sees the candidate, sees the
  // partial-capture flag, decides whether to dig further.
  const headline = visibleSignals.headline ?? "";
  const titleLooksSenior = /\b(senior|lead|principal|head|director|manager|staff)\b/i.test(headline);
  const titleLooksJunior = /\b(junior|graduate|intern|trainee)\b/i.test(headline);

  const titleFit = headline ? (titleLooksSenior ? 60 : titleLooksJunior ? 30 : 50) : 30;
  const seniorityFit = titleLooksSenior ? 65 : titleLooksJunior ? 35 : 50;
  const locationFit = visibleSignals.location ? 75 : 40;

  return buildScoreBreakdown({
    categories: {
      skill_fit:        { score: 30, weight: args.weights?.skill_fit ?? CATEGORY_WEIGHTS_V2.skill_fit, evidence: "Skills section not visible in current capture — can't verify must-haves directly." },
      location_fit:     { score: locationFit, weight: args.weights?.location_fit ?? CATEGORY_WEIGHTS_V2.location_fit, evidence: visibleSignals.location ? `Location visible: ${visibleSignals.location}.` : "Location not visible." },
      seniority_fit:    { score: seniorityFit, weight: args.weights?.seniority_fit ?? CATEGORY_WEIGHTS_V2.seniority_fit, evidence: headline ? `Inferred from headline: "${headline}".` : "Headline not visible." },
      title_fit:        { score: titleFit, weight: args.weights?.title_fit ?? CATEGORY_WEIGHTS_V2.title_fit, evidence: headline ? `Headline: "${headline}".` : "Title not visible." },
      domain_fit:       { score: 40, weight: args.weights?.domain_fit ?? CATEGORY_WEIGHTS_V2.domain_fit, evidence: "Domain not assessable without work history." },
      nice_to_have_fit: { score: 40, weight: args.weights?.nice_to_have_fit ?? CATEGORY_WEIGHTS_V2.nice_to_have_fit, evidence: "Nice-to-haves not assessable without work history." },
    },
    must_have_coverage: args.parsedRoleMustHaves.map((req) => ({
      requirement: req,
      status:      "unknown" as MustHaveCoverageStatus,
      evidence:    "Not visible in current capture — may exist in full work history.",
    })),
    nice_to_have_coverage: args.parsedRoleNiceToHaves.map((req) => ({
      requirement: req,
      status:      "absent" as NiceToHaveCoverageStatus,
      evidence:    "Not visible in current capture.",
    })),
    reasons_for:           [
      ...(headline ? [`${headline} — visible from current capture.`] : []),
      ...(visibleSignals.location ? [`Located in ${visibleSignals.location}.`] : []),
    ],
    // Critical: do NOT fabricate rejection reasons from absent data.
    reasons_against:       [],
    missing_evidence:      ["Full work history not captured — must-haves can't be verified from current data."],
    recruiter_summary:     "Score reflects visible LinkedIn data only — work history not fully captured. Treat as directional ranking signal at sourcing stage.",
    profileCharCount:      args.profileCharCount,
    profileCaptureWarning: {
      code:     "incomplete_capture",
      message:  "Partial LinkedIn capture — score is based on visible content (headline, location, seniority). Full work history was not pulled.",
      evidence: [args.reasonInsufficient],
    },
    weights:            args.weights,
    claudeOverallScore: null,
  });
}

export function analyseProfileCaptureCompleteness(args: {
  profileText: string;
  recruiterSummary?: string;
  reasonsAgainst?: string[];
  missingEvidence?: string[];
  /**
   * When true, ONLY fire the warning if the AI itself flagged the profile
   * as a stub (Claude's prose contains "do not progress without",
   * "near-empty stub", "no work history", etc.). Skip the text-only
   * branch (year-range count + heading detection).
   *
   * Used after the Stage 1 deterministic gate has cleared a profile —
   * Stage 1 already analysed the text-only signals; we don't want to
   * double-gate. But we still listen to Claude when it reads the prose
   * and recognises "current role captured but historical roles missed"
   * (Brendan's partial-capture failure mode). That AI signal is real
   * and Stage 1 can't see it (it only sees regex over raw text).
   */
  aiOnly?: boolean;
}): ProfileCaptureWarning | null {
  const profileText = args.profileText.replace(/\r/g, "").trim();
  if (profileText.length < 2000) return null;

  const aiText = [
    args.recruiterSummary,
    ...(args.reasonsAgainst ?? []),
    ...(args.missingEvidence ?? []),
  ].filter(Boolean).join("\n");
  // Two-tier detection: the deterministic marker is the primary signal
  // (added to the scoring prompt and stable across model phrasings); the
  // legacy phrase regex is the safety net for cases where the model omits
  // the marker.
  const aiSaysStub = STUB_MARKER_RE.test(aiText) || STUB_SIGNAL_RE.test(aiText);

  // Post-Stage-1 path: only the AI signal counts.
  if (args.aiOnly) {
    if (!aiSaysStub) return null;
    return {
      code: "incomplete_capture",
      message: "LinkedIn capture appears incomplete — Claude flagged missing work history. Upload CV or re-fetch the full profile before assessing.",
      evidence: ["AI assessment described the profile as a stub or requested a full CV/work history"],
    };
  }

  const yearRanges = profileText.match(YEAR_RANGE_RE) ?? [];
  const hasExperienceHeading = EXPERIENCE_HEADING_RE.test(profileText);
  const looksLikeCapturedProfile = PROFILE_SECTION_HEADING_RE.test(profileText);
  const hasVeryFewWorkEntries = yearRanges.length < 2;

  if (!aiSaysStub && !looksLikeCapturedProfile) return null;
  if (!aiSaysStub && (hasExperienceHeading || !hasVeryFewWorkEntries)) return null;

  const evidence = [
    `${yearRanges.length} dated work-history entr${yearRanges.length === 1 ? "y" : "ies"} detected`,
  ];
  if (!hasExperienceHeading) evidence.push("No clear Experience / Work history section detected");
  if (aiSaysStub) evidence.push("AI assessment described the profile as a stub or requested a full CV/work history");

  return {
    code: "incomplete_capture",
    message: "LinkedIn capture may be incomplete — upload CV or check the full work history before deciding.",
    evidence,
  };
}

// Threshold below which a must-have is considered "soft skill" / behavioural
// and excluded from the must-have pct formula. Items returning < 0.8 from
// getMustHaveImportance are typically pure soft traits ("communication",
// "team player", "deadline-driven"). They're kept in the coverage array for
// recruiter visibility but don't gate the score, because:
//   1) They can't be reliably verified from a LinkedIn profile.
//   2) Claude marks them "likely" on almost any senior-ish candidate, which
//      pulled must_have_pct ~15pts higher than the technical-only formula.
//   3) On JDs with many soft skills (Co-Op .NET Dev had 14 must-haves with 5
//      behavioural), the soft items effectively rescued candidates with weak
//      technical coverage.
export const SOFT_SKILL_IMPORTANCE_THRESHOLD = 0.8;

export function isSoftSkillRequirement(requirement: string): boolean {
  return getMustHaveImportance(requirement) < SOFT_SKILL_IMPORTANCE_THRESHOLD;
}

export function computeMustHavePct(
  coverage: MustHaveStatus[],
  dataQuality: DataQuality = "full_profile"
): number {
  // No must-haves defined on the role — treat as neutral 50, not 100.
  // Returning 100 here was inflating all scores when parsedRole had no requirements.
  if (coverage.length === 0) return 50;

  // Filter to scoring-eligible must-haves only. Soft-skill items stay in the
  // breakdown.must_have_coverage array (the recruiter still sees them on
  // the candidate card) but don't contribute to must_have_pct.
  const scoringCoverage = coverage.filter((c) => !isSoftSkillRequirement(c.requirement));

  // All must-haves were soft-skill (rare). Score must_have_pct as neutral 50
  // so other dimensions decide. Without this guard we'd divide by zero.
  if (scoringCoverage.length === 0) return 50;

  const pointTable = MUST_HAVE_POINTS_BY_QUALITY[dataQuality];

  let totalPoints = 0;
  let totalWeight = 0;
  for (const c of scoringCoverage) {
    const importance = getMustHaveImportance(c.requirement);
    totalPoints += pointTable[c.status] * importance;
    totalWeight += importance;
  }

  return Math.round(totalPoints / totalWeight);
}

export function computeNiceToHavePct(coverage: NiceToHaveStatus[]): number {
  if (coverage.length === 0) return 50;
  const total = coverage.reduce((sum, c) => sum + NICE_TO_HAVE_POINTS[c.status], 0);
  return Math.round(total / coverage.length);
}

export function computeEvidenceCoverageScore(
  mustHaveCoverage:    MustHaveStatus[],
  niceToHaveCoverage:  NiceToHaveStatus[]
): number {
  const total = mustHaveCoverage.length + niceToHaveCoverage.length;
  if (total === 0) return 0;
  const explicit =
    mustHaveCoverage.filter((c) => c.status === "confirmed" || c.status === "equivalent").length +
    niceToHaveCoverage.filter((c) => c.status === "confirmed").length;
  return Math.round((explicit / total) * 100);
}

export function computeOverallScore(
  categories: ScoreBreakdown["categories"],
  mustHavePct: number,
  weights?: ScoringWeights
): number {
  // Backward compat: old records stored industry_fit + keyword_alignment instead of domain_fit.
  // Use industry_fit as the direct domain proxy — cleaner than the weighted formula which
  // introduced rounding drift when keyword_alignment was absent. Legacy candidates score
  // within ~2pts of their original; clicking Re-score will compute domain_fit properly.
  const domainScore = categories.domain_fit?.score ??
    categories.industry_fit?.score ??
    50;

  const w = weights ?? CATEGORY_WEIGHTS_V2;
  const mustHaveW = weights ? weights.must_have : MUST_HAVE_WEIGHT_V2;

  const weighted =
    categories.skill_fit.score        * w.skill_fit +
    categories.location_fit.score     * w.location_fit +
    categories.seniority_fit.score    * w.seniority_fit +
    categories.title_fit.score        * w.title_fit +
    domainScore                       * w.domain_fit +
    categories.nice_to_have_fit.score * w.nice_to_have_fit +
    mustHavePct                       * mustHaveW;

  return Math.min(100, Math.max(0, Math.round(weighted)));
}

export function computeConfidence(
  profileCharCount: number,
  mustHaveCoverage: MustHaveStatus[]
): ScoreBreakdown["confidence"] {
  const reasons: string[] = [];
  const quality = classifyDataQuality(profileCharCount);

  // Base reflects how much raw data is available to make an assessment.
  let score: number;
  if (quality === "full_profile") {
    score = 70;
    reasons.push("Full profile text available");
  } else if (quality === "snippet") {
    score = 48;
    reasons.push("Partial profile — some must-haves may not be fully verifiable");
  } else {
    score = 15;
    reasons.push("Minimal data — score is largely speculative");
  }

  const total = mustHaveCoverage.length;
  if (total > 0) {
    const supportedCount = mustHaveCoverage.filter(
      (c) => c.status === "confirmed" || c.status === "equivalent" || c.status === "likely"
    ).length;
    const unknownCount  = mustHaveCoverage.filter((c) => c.status === "unknown").length;
    const negativeCount = mustHaveCoverage.filter((c) => c.status === "negative").length;

    // "unknown" = genuine uncertainty — we cannot assess this at all.
    // "missing" / "negative" = clear assessments; they affect the score but not confidence.
    const unknownFrac = unknownCount / total;
    if (unknownFrac > 0.5) {
      score -= 30;
      reasons.push(`${unknownCount} of ${total} must-haves unverified — insufficient data`);
    } else if (unknownFrac > 0.25) {
      score -= 10;
      reasons.push(`${unknownCount} must-have(s) not confirmable from profile`);
    } else if (unknownCount > 0) {
      score -= 5;
    }

    // Bonus for strong, low-uncertainty coverage.
    const supportedFrac = supportedCount / total;
    if (supportedFrac >= 0.75 && unknownCount <= 1 && negativeCount === 0) {
      const bonus = quality === "full_profile" ? 15 : quality === "snippet" ? 8 : 0;
      if (bonus > 0) {
        score += bonus;
        reasons.push(`${supportedCount} of ${total} must-haves confirmed or likely`);
      }
    }

    if (negativeCount > 0) {
      score -= negativeCount * 35;
      reasons.push(`${negativeCount} must-have(s) contradicted by the profile`);
    }
  }

  score = Math.min(100, Math.max(0, score));

  const level: ConfidenceLevel =
    score >= 70 ? "high" :
    score >= 40 ? "medium" :
    "low";

  return { level, score, reasons };
}

export function buildScoreBreakdown(params: {
  categories:            ScoreBreakdown["categories"];
  must_have_coverage:    MustHaveStatus[];
  nice_to_have_coverage: NiceToHaveStatus[];
  reasons_for:           string[];
  reasons_against:       string[];
  missing_evidence:      string[];
  recruiter_summary:     string;
  profileCharCount:      number;
  profileCaptureWarning?: ProfileCaptureWarning | null;
  weights?:              ScoringWeights;
  claudeOverallScore?:   number | null; // Claude's direct holistic verdict — overrides formula when present
}): ScoreBreakdown {
  const dataQuality   = classifyDataQuality(params.profileCharCount);
  const mustHavePct   = computeMustHavePct(params.must_have_coverage, dataQuality);
  const niceToHavePct = computeNiceToHavePct(params.nice_to_have_coverage);
  const rawOverall    = computeOverallScore(params.categories, mustHavePct, params.weights);

  // Base cap by data quality: snippets/partial captures are leads, not confirmed matches.
  let cap =
    dataQuality === "snippet"
      ? params.profileCharCount < 500 ? 54 : 65
      : dataQuality === "minimal" ? 40 : 100;
  if (params.profileCaptureWarning) {
    cap = Math.min(cap, 50);
  }

  // Critical gate for snippets/minimal: if any 1.5× must-have is unconfirmed, cap hard —
  // the candidate cannot be presented as a real match until a full profile proves otherwise.
  if (dataQuality !== "full_profile") {
    // "equivalent" counts as satisfied — only unresolved statuses trigger the cap
    const criticalUnconfirmed = params.must_have_coverage.filter(
      (c) =>
        getMustHaveImportance(c.requirement) >= 1.5 &&
        (c.status === "missing" || c.status === "negative" || c.status === "unknown")
    );
    if (criticalUnconfirmed.length > 0) {
      // Each additional unconfirmed critical drops the cap by 8 more points
      const compoundedCap = Math.max(20, 45 - (criticalUnconfirmed.length - 1) * 8);
      cap = Math.min(cap, compoundedCap);
    }
  }

  // Critical gate for full profiles: if a 1.5× must-have is confirmed missing,
  // negative, OR unknown on a detailed profile (>2500 chars), cap the score.
  // "unknown" is included because on a detailed profile absence is informative —
  // the prompt instructs Claude to use "missing" not "unknown" when a named
  // tech domain is simply absent from a long profile, but Claude occasionally
  // returns "unknown" anyway (e.g. "no evidence of Sybase"). Both are treated
  // identically here: a recruiter should not see 65%+ when the most critical
  // requirement cannot be confirmed from a full profile.
  if (dataQuality === "full_profile") {
    // Match the full_profile classification threshold (≥2000) so there's no gap
    // between "classified as full_profile" and "absence is treated as informative".
    const charCountIsDetailed = params.profileCharCount >= 2000;
    const criticalMissing = params.must_have_coverage.filter(
      (c) =>
        getMustHaveImportance(c.requirement) >= 1.5 &&
        (c.status === "missing" || c.status === "negative" ||
         (c.status === "unknown" && charCountIsDetailed))
    );
    if (criticalMissing.length > 0) {
      cap = Math.min(cap, 50);
    }

    const criticalHistorical = params.must_have_coverage.filter(
      (c) =>
        getMustHaveImportance(c.requirement) >= 1.5 &&
        c.status === "likely_historical"
    );
    if (criticalHistorical.length > 0) {
      // Historical evidence is real evidence, but for critical must-haves it
      // should not rank as a strong current match without fresher proof.
      const historicalCap = Math.max(54, 62 - (criticalHistorical.length - 1) * 4);
      cap = Math.min(cap, historicalCap);
    }
  }

  const formulaOverall = Math.min(rawOverall, cap);

  // When Claude provides a direct overall_score, trust it — Claude integrates
  // the full picture better than a weighted formula can. The formula-derived
  // score is kept as a floor reference: we still apply the data-quality cap
  // so snippet candidates can't be boosted above their information ceiling,
  // but within that cap Claude's verdict wins over the formula's arithmetic.
  if (params.claudeOverallScore != null) {
    const delta = Math.abs(params.claudeOverallScore - formulaOverall);
    if (delta > 15) {
      console.warn(
        `[scoring] formula/Claude divergence ${delta}pt — formula=${formulaOverall} Claude=${params.claudeOverallScore} cap=${cap} quality=${dataQuality}`
      );
    }
  }
  // Partial captures: still produce a real score from visible content
  // (location, seniority, title) but cap to 50 — the recruiter at sourcing
  // stage needs a number to rank candidates, but we shouldn't let a thin
  // capture push past the moderate-match threshold. The breakdown still
  // carries profile_capture_warning so the UI shows a "partial profile"
  // confidence badge alongside the score.
  const preConfidenceOverall = params.claudeOverallScore != null
    ? Math.min(cap, params.claudeOverallScore)   // Claude's score, still capped by data quality
    : formulaOverall;

  const evidenceCoverage = computeEvidenceCoverageScore(
    params.must_have_coverage,
    params.nice_to_have_coverage
  );
  const confidence = computeConfidence(params.profileCharCount, params.must_have_coverage);

  // Confidence-aware ceiling: when we genuinely don't know much about the
  // candidate (confidence < 30 — typically minimal data + no confirmed
  // must-haves + several unknowns), cap the displayed score at 40 so a
  // recruiter scanning the list doesn't see "60% match" next to a
  // "low confidence — insufficient data" badge. The data-quality cap
  // already caps snippet/minimal data; this adds a coverage-aware second
  // axis so high-formula / no-evidence cases get capped too.
  // Higher confidence thresholds are intentionally NOT enforced — a
  // moderate-confidence candidate may have a legitimately good score.
  const overall = confidence.score < 30
    ? Math.min(preConfidenceOverall, 40)
    : preConfidenceOverall;
  if (params.profileCaptureWarning) {
    confidence.score = Math.min(confidence.score, 35);
    confidence.level = "low";
    confidence.reasons = [
      params.profileCaptureWarning.message,
      ...confidence.reasons,
    ].slice(0, 5);
  }

  const effectiveReasonsAgainst = [...params.reasons_against];
  if (params.profileCaptureWarning) {
    effectiveReasonsAgainst.unshift("LinkedIn capture appears incomplete — do not reject or progress without CV or full work-history evidence");
  }
  if (params.claudeOverallScore != null && params.claudeOverallScore > cap) {
    effectiveReasonsAgainst.push(
      params.profileCaptureWarning
        ? `Score capped at ${overall} — LinkedIn capture appears incomplete; upload CV before deciding`
        : `Score capped at ${overall} — provisional snippet data; fetch full profile for reliable assessment`
    );
  } else if (params.claudeOverallScore == null && rawOverall > overall) {
    if (dataQuality !== "full_profile") {
      effectiveReasonsAgainst.push(`Score capped at ${overall} — provisional snippet data; fetch full profile for reliable assessment`);
    } else {
      effectiveReasonsAgainst.push(`Score reduced from ${rawOverall} to ${overall} — critical requirement confirmed absent from full profile`);
    }
  }

  // Build augmented missing_evidence:
  // 1. Auto-add clearance/citizenship note when a 1.5× clearance must-have is unresolved.
  // 2. Flag soft-skill-heavy JDs where the 36% must-have weight is being diluted by
  //    unmeasurable requirements — scoring is directional only in that case.
  const effectiveMissingEvidence = [...params.missing_evidence];
  if (params.profileCaptureWarning) {
    effectiveMissingEvidence.unshift("Full work history from LinkedIn or CV is required before treating this score as reliable");
  }

  const CLEARANCE_RE = /security clearance|secret vetting|confidential vetting|nz citizen|nz resident|work rights|right to work/i;
  const hasUnresolvedClearance = params.must_have_coverage.some(
    (c) => CLEARANCE_RE.test(c.requirement) &&
           getMustHaveImportance(c.requirement) >= 1.5 &&
           (c.status === "missing" || c.status === "unknown")
  );
  if (hasUnresolvedClearance && !effectiveMissingEvidence.some((e) => /clearance|citizenship|work rights/i.test(e))) {
    effectiveMissingEvidence.push("NZ citizenship and clearance history are not visible on LinkedIn — require direct confirmation from the candidate");
  }

  if (params.must_have_coverage.length >= 3) {
    const softSkillCount = params.must_have_coverage.filter(
      (c) => getMustHaveImportance(c.requirement) < 0.8
    ).length;
    if (softSkillCount / params.must_have_coverage.length >= 0.5) {
      effectiveMissingEvidence.push("Most must-have requirements are soft skills that cannot be reliably assessed from a LinkedIn profile — treat this score as directional");
    }
  }

  return {
    version:                 2,
    overall,
    evidence_coverage_score: evidenceCoverage,
    categories:              params.categories,
    must_have_coverage:      params.must_have_coverage,
    must_have_pct:           mustHavePct,
    nice_to_have_coverage:   params.nice_to_have_coverage,
    nice_to_have_pct:        niceToHavePct,
    reasons_for:             params.reasons_for.slice(0, 4),
    reasons_against:         effectiveReasonsAgainst.slice(0, 4),
    missing_evidence:        effectiveMissingEvidence.slice(0, 4),
    confidence,
    data_quality:            dataQuality,
    ...(params.profileCaptureWarning ? { profile_capture_warning: params.profileCaptureWarning } : {}),
    recruiter_summary:       params.recruiter_summary,
  };
}
