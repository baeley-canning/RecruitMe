/**
 * Reusable candidate-profile insight extractor.
 *
 * Produces a structured, provenance-tagged ProfileInsight payload from a
 * sanitised profile text + parsedRole context. The output is "what we know
 * about this person, independent of any job" — never per-role scoring.
 * Per-role scoring stays on Candidate.matchScore / scoreBreakdown.
 *
 * Design notes:
 *  • Conservative extraction — "unknown" for thin profiles, never guess.
 *  • Every fact in factsJson must be supported by a verbatim quote in
 *    evidenceSnippets[]. Mirrors the same evidence discipline as the
 *    scoring prompt (src/lib/ai/scoring.ts) so hallucinations are
 *    catchable post-hoc.
 *  • Provenance is captured at every persistence boundary: extractedBy
 *    ("claude" | "ollama" — propagated from chatWithFailover.source),
 *    modelId (the exact model string at call time), promptVersion
 *    (bumped on every prompt edit), extractionVersion (bumped only after
 *    a re-extraction sweep validates a new prompt).
 *  • sourceProfileTextHash is computed from a *normalised* projection of
 *    the input — lowercase + whitespace-collapse — so cosmetic edits
 *    (line-ending flips, extra spaces) don't trigger re-extraction.
 *  • Goes through chatWithFailover + withRetry like all other AI calls.
 *    The local Ollama failover is fine for one-off insight extractions;
 *    provenance is recorded so cross-role consumers can audit which model
 *    produced what.
 *
 * Versioning policy:
 *  • INSIGHT_PROMPT_VERSION bumps on any prompt edit.
 *  • INSIGHT_EXTRACTION_VERSION is the integer gate ProfileInsight uses
 *    to control which rows the Stage 1 ranker trusts. Bumping it is a
 *    deliberate, post-validation action — don't bump just because the
 *    prompt changed. New extractions land with the current value; the
 *    Stage 1 ranker filters on >= MIN_VERSION_FOR_RANKING from PR 3.
 */

import { createHash } from "crypto";
import { chatWithFailover, type ChatSource } from "./chat-with-failover";
import { parseJson, withRetry } from "./chat";

/** Bump on prompt edits. Persisted in ProfileInsight.promptVersion. */
export const INSIGHT_PROMPT_VERSION = "insight-v1.0";

/** Integer gate for the Stage 1 ranker. New insights land at this version.
 *  PR 3 reads MIN_VERSION_FOR_RANKING (a separate constant) to decide which
 *  rows to trust for retrieval; until that gate is bumped, the ranker may
 *  ignore old extractions. Keep them in lock-step manually. */
export const INSIGHT_EXTRACTION_VERSION = 1;

/** The Stage-1 ranker (flywheel read-path) trusts only insight rows at or above
 *  this version — the gate that lets a prompt/schema re-extraction quarantine
 *  stale rows by bumping INSIGHT_EXTRACTION_VERSION without the ranker reading
 *  them in the interim. Equal to the current version today; raise the floor
 *  when a re-extraction sweep is in flight. */
export const MIN_VERSION_FOR_RANKING = 1;

export interface InsightEducation {
  institution: string;
  degree?: string;
  fieldOfStudy?: string;
  graduationYear?: number;
}

export interface InsightEvidenceSnippet {
  /** Which extracted field this quote supports (e.g. "primaryStack", "currentTitle"). */
  field: string;
  /** The asserted value (e.g. "typescript", or "Senior Software Engineer"). */
  value: string;
  /** Verbatim quote from the sanitised profile text. Must be a substring. */
  quote: string;
}

/**
 * The structured payload persisted as ProfileInsight.factsJson. Every field
 * is optional / nullable so consumers can render "unknown" gracefully.
 */
export interface InsightFacts {
  currentTitle: string | null;
  currentEmployer: string | null;
  primaryStack: string[];
  secondaryStack: string[];
  domains: string[];
  titlesHeld: string[];
  education: InsightEducation[];
  certifications: string[];
  evidenceSnippets: InsightEvidenceSnippet[];
  /** Set by validator when input profileText was below the extraction
   *  threshold — extractor returns "unknown" for everything and flags this
   *  so consumers don't mistake it for a confident-empty result. */
  thinProfile?: boolean;
}

export interface ExtractedInsight {
  facts: InsightFacts;
  /** Which provider actually produced the JSON — "claude" or "ollama". */
  extractedBy: ChatSource;
  /** Exact model identifier at call time (the env-configured default). */
  modelId: string;
  /** SHA-256 of normalised profile text (the input the extractor saw). */
  sourceProfileTextHash: string;
  /** Prompt version persisted alongside the facts. */
  promptVersion: string;
  /** Extraction version persisted as the gate. */
  extractionVersion: number;
}

/** Minimum profile-text length for AI extraction. Below this, the extractor
 *  returns a stub "thinProfile" insight without spending tokens. */
export const INSIGHT_MIN_PROFILE_CHARS = 500;

const SYSTEM_INSTRUCTIONS = `You are extracting reusable, role-agnostic professional facts about a candidate from their profile text. These facts will be reused across many job evaluations, so they must be:

- Universal (not tied to any specific job or recruiter context).
- Evidence-grounded (every non-unknown fact must be backed by a verbatim quote that appears in the input text).
- Conservative (return "unknown" rather than guess; missing data is fine).

You must NOT include:
- Per-job scoring (no matchScore, no recruiter_summary, no must-have coverage).
- Subjective opinions about strengths/weaknesses.
- Salary expectations, visa status, availability, notice period.
- Any recruiter notes — assume the input is already sanitised, but if you see what looks like an internal annotation, ignore it.

Return ONLY compact JSON (no markdown, no prose) matching exactly this schema:
{
  "currentTitle": string|null,
  "currentEmployer": string|null,
  "primaryStack": [string],
  "secondaryStack": [string],
  "domains": [string],
  "titlesHeld": [string],
  "education": [{"institution": string, "degree"?: string, "fieldOfStudy"?: string, "graduationYear"?: number}],
  "certifications": [string],
  "evidenceSnippets": [{"field": string, "value": string, "quote": string}]
}

Rules:
- primaryStack: 3-8 entries. Most-used tools/languages/frameworks. Lowercase, deduped.
- secondaryStack: 0-5 entries. Tools mentioned but not used heavily.
- domains: industries the person has worked in (e.g. "fintech", "government", "education").
- titlesHeld: most-recent first. Roles only — don't include volunteer/coaching activities unless they ARE the role.
- evidenceSnippets MUST include at least one quote per extracted non-null/non-empty field. Quotes are verbatim — copy them exactly from the input. No paraphrasing.
- If a field cannot be supported by a quote, return null/[] for it. Do not invent.
- titlesHeld + primaryStack are the load-bearing fields for cross-role retrieval — be thorough.`;

function buildUserPrompt(profileText: string): string {
  return `Extract reusable facts from this candidate profile. Return ONLY JSON.

<profile_text>
${profileText}
</profile_text>`;
}

/**
 * Compute the canonical hash of profile text. Normalises lowercase +
 * whitespace-collapse so cosmetic edits don't trigger re-extraction.
 * Critic B §6 flagged that a naive raw-text hash gets thrashed by header
 * normalisers flipping one whitespace char per nightly sync.
 */
export function hashProfileTextForInsight(raw: string): string {
  const normalised = raw.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalised).digest("hex");
}

/**
 * Resolve the model id that would be used for a given source. Mirrors the
 * fallback chain in src/lib/ai/chat.ts. Persisted into ProfileInsight.modelId
 * so consumers know which exact model produced the extraction.
 */
function resolveModelId(source: ChatSource): string {
  if (source === "claude") {
    return process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
  }
  return process.env.OLLAMA_MODEL ?? "qwen2.5:1.5b";
}

/**
 * Validates a raw AI JSON response and coerces it into the canonical
 * InsightFacts shape. Drops unknown keys, defaults missing fields, filters
 * evidence snippets whose quotes don't appear in the source text (the
 * hallucination guard — same shape as the scoring evidence-coverage filter).
 */
function validateAndCoerce(raw: unknown, sourceText: string): InsightFacts {
  const r = (raw ?? {}) as Record<string, unknown>;

  const asString = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const trimmed = v.trim();
    return trimmed ? trimmed : null;
  };
  const asStringArr = (v: unknown): string[] => {
    if (!Array.isArray(v)) return [];
    return v
      .map((x) => asString(x))
      .filter((x): x is string => x !== null)
      .map((x) => x.toLowerCase()) // primary/secondary stack + domains are lowercased
      .filter((x, i, a) => a.indexOf(x) === i); // dedup
  };
  const asTitlesArr = (v: unknown): string[] => {
    // Titles preserve case for display.
    if (!Array.isArray(v)) return [];
    return v
      .map((x) => asString(x))
      .filter((x): x is string => x !== null);
  };

  const lowerSource = sourceText.toLowerCase();
  const evidenceSnippets: InsightEvidenceSnippet[] = Array.isArray(r.evidenceSnippets)
    ? (r.evidenceSnippets as unknown[])
        .map((e): InsightEvidenceSnippet | null => {
          if (!e || typeof e !== "object") return null;
          const obj = e as Record<string, unknown>;
          const field = asString(obj.field);
          const value = asString(obj.value);
          const quote = asString(obj.quote);
          if (!field || !value || !quote) return null;
          // Hallucination guard: quote must be present (case-insensitive)
          // in the source text. Reject anything else — the extractor lied.
          if (!lowerSource.includes(quote.toLowerCase())) return null;
          // Cap quote length — keep snippets short, reduce blast radius.
          const capped = quote.length > 240 ? `${quote.slice(0, 240)}…` : quote;
          return { field, value, quote: capped };
        })
        .filter((e): e is InsightEvidenceSnippet => e !== null)
    : [];

  const education: InsightEducation[] = Array.isArray(r.education)
    ? (r.education as unknown[])
        .map((e): InsightEducation | null => {
          if (!e || typeof e !== "object") return null;
          const obj = e as Record<string, unknown>;
          const institution = asString(obj.institution);
          if (!institution) return null;
          return {
            institution,
            degree: asString(obj.degree) ?? undefined,
            fieldOfStudy: asString(obj.fieldOfStudy) ?? undefined,
            graduationYear:
              typeof obj.graduationYear === "number" && Number.isFinite(obj.graduationYear)
                ? Math.floor(obj.graduationYear)
                : undefined,
          };
        })
        .filter((e): e is InsightEducation => e !== null)
    : [];

  return {
    currentTitle: asString(r.currentTitle),
    currentEmployer: asString(r.currentEmployer),
    primaryStack: asStringArr(r.primaryStack).slice(0, 8),
    secondaryStack: asStringArr(r.secondaryStack).slice(0, 5),
    domains: asStringArr(r.domains).slice(0, 8),
    titlesHeld: asTitlesArr(r.titlesHeld),
    education,
    certifications: asTitlesArr(r.certifications),
    evidenceSnippets,
  };
}

/**
 * Stub insight returned when profileText is below INSIGHT_MIN_PROFILE_CHARS.
 * No AI tokens spent. Caller decides whether to persist this — typically
 * yes, so we have a marker that "we tried; profile was too thin".
 */
export function buildThinProfileInsight(): InsightFacts {
  return {
    currentTitle: null,
    currentEmployer: null,
    primaryStack: [],
    secondaryStack: [],
    domains: [],
    titlesHeld: [],
    education: [],
    certifications: [],
    evidenceSnippets: [],
    thinProfile: true,
  };
}

export interface ExtractInsightOptions {
  /** profileText AFTER sanitisation (sanitiseProfileTextForInsight). Caller is
   *  responsible for passing pre-sanitised text — this keeps the extractor
   *  layer ignorant of recruiter-note shapes. */
  profileText: string;
  /** Org for cost attribution + spend cap. */
  orgId?: string | null;
  /** Optional user attribution for UsageEvent. */
  userId?: string | null;
}

/**
 * Extract a ProfileInsight from sanitised profileText.
 *
 * Returns the validated facts + provenance metadata. Does NOT persist —
 * persistence is the caller's job (typically src/lib/insight-cache.ts).
 *
 * For inputs below INSIGHT_MIN_PROFILE_CHARS, returns a "thinProfile" stub
 * without spending tokens; callers can still persist the row to mark
 * "we tried" against the current hash.
 */
export async function extractInsight(opts: ExtractInsightOptions): Promise<ExtractedInsight> {
  const profileText = opts.profileText ?? "";
  const sourceProfileTextHash = hashProfileTextForInsight(profileText);

  // Thin profile fast path — no AI tokens spent.
  if (profileText.trim().length < INSIGHT_MIN_PROFILE_CHARS) {
    return {
      facts: buildThinProfileInsight(),
      extractedBy: "claude", // The thin-profile path is deterministic; pick the default tag.
      modelId: "deterministic-thin-profile-stub",
      sourceProfileTextHash,
      promptVersion: INSIGHT_PROMPT_VERSION,
      extractionVersion: INSIGHT_EXTRACTION_VERSION,
    };
  }

  // Real extraction. Wrap in withRetry so transient 5xx/429 errors don't
  // turn into permanent "no insight" rows. Capture the source so the
  // persisted row knows whether Claude or Ollama did the work.
  const sourceRef: { value: ChatSource } = { value: "claude" };
  const text = await withRetry(async () => {
    const result = await chatWithFailover(buildUserPrompt(profileText), 0.1, 2048, {
      system: SYSTEM_INSTRUCTIONS,
      cacheSystem: true, // Anthropic prompt cache — system block is static.
      orgId: opts.orgId,
      userId: opts.userId,
      costTag: "insight_extract",
    });
    sourceRef.value = result.source;
    return result.text;
  });

  let raw: unknown;
  try {
    raw = parseJson(text);
  } catch (err) {
    // Surface a clear error message that includes the response head so
    // the failure mode is debuggable in logs. Caller logs + decides
    // whether to retry or persist a thin-profile stub.
    throw new Error(
      `extractInsight: unparseable JSON response (head=${JSON.stringify(text.slice(0, 200))}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const facts = validateAndCoerce(raw, profileText);

  return {
    facts,
    extractedBy: sourceRef.value,
    modelId: resolveModelId(sourceRef.value),
    sourceProfileTextHash,
    promptVersion: INSIGHT_PROMPT_VERSION,
    extractionVersion: INSIGHT_EXTRACTION_VERSION,
  };
}
