import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { createHash } from "crypto";

/** Short SHA-256 fingerprint of profile text. */
export function hashProfileText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// Bumped when the cache key shape changes so old keys don't match.
// v5 → v6: deterministic Stage 1 gate added — refuses to score stub captures
// (Brendan-class failure) and injects matched signals as ground truth into
// the Claude prompt. Every score produced before this gate is potentially
// suspect (stub captures got 12% with fabricated reasons); bumping the
// version invalidates cached scores so the next re-score path runs through
// the new gate.
const SCORE_CACHE_VERSION = "score-context-v6-deterministic-gate";

type ScoreCacheKeyInput = {
  profileText: string;
  parsedRole: unknown;
  salary: { min: number; max: number } | null;
  jobLocation?: string | null;
  /** Optional secondary location for dual-site roles. Included in the cache
   * key so adding/changing the second location invalidates stale scores. */
  jobLocation2?: string | null;
  isRemote?: boolean | null;
  // Scoring weights — when the recruiter / job overrides org defaults the
  // resulting score changes, so the key has to include them or stale cached
  // scores will keep showing through after a weights edit.
  weights?: unknown;
};

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));

  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
    .join(",")}}`;
}

export function buildScoreCacheKey(input: ScoreCacheKeyInput): string {
  const payload = stableStringify({
    version: SCORE_CACHE_VERSION,
    profileTextHash: hashProfileText(input.profileText),
    parsedRole: input.parsedRole,
    salary: input.salary,
    jobLocation: input.jobLocation ?? null,
    // jobLocation2 stays out of the key when both undefined AND null so the
    // cache stays valid for jobs that never used a secondary location. When
    // set, it participates in the hash and changing it invalidates the cache.
    ...(input.jobLocation2 != null ? { jobLocation2: input.jobLocation2 } : {}),
    isRemote: input.isRemote ?? false,
    weights: input.weights ?? null,
  });

  return createHash("sha256").update(payload).digest("hex").slice(0, 24);
}

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// scoreColor/scoreBg were removed — see src/lib/score-utils.ts for the
// canonical scoreTier / scoreTierColor / scoreTierLabel helpers used by the
// match-score UI (the old helpers used a different 75/50 breakpoint that
// disagreed with everywhere else in the app and had no remaining call sites).

export function statusLabel(status: string): string {
  const map: Record<string, string> = {
    new:          "New",
    reviewing:    "Reviewing",
    shortlisted:  "Shortlisted",
    contacted:    "Contacted",
    interviewing: "Interviewing",
    offer_sent:   "Offer Sent",
    hired:        "Hired",
    declined:     "Declined",
    rejected:     "Not suitable",
  };
  return map[status] ?? status;
}

export function statusBadge(status: string): string {
  const map: Record<string, string> = {
    new:          "bg-surface-hover text-text-secondary",
    reviewing:    "bg-surface-hover text-text-secondary",
    shortlisted:  "bg-accent-subtle text-accent",
    contacted:    "bg-warning-subtle text-warning",
    interviewing: "bg-warning-subtle text-warning",
    offer_sent:   "bg-warning-subtle text-warning",
    hired:        "bg-success-subtle text-success",
    declined:     "bg-surface-hover text-text-tertiary",
    rejected:     "bg-surface-hover text-text-tertiary",
  };
  return map[status] ?? "bg-surface-hover text-text-secondary";
}

// Ordered pipeline stages for display
export const PIPELINE_STAGES = [
  "new", "reviewing", "shortlisted", "contacted",
  "interviewing", "offer_sent", "hired", "declined", "rejected",
] as const;
export type PipelineStage = typeof PIPELINE_STAGES[number];

export function safeParseJson<T>(str: string | null | undefined, fallback: T): T {
  if (!str) return fallback;
  try {
    return JSON.parse(str) as T;
  } catch {
    return fallback;
  }
}

export function timeAgo(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const diff = Date.now() - d.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}
