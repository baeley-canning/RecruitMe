import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { createHash } from "crypto";

/** Short SHA-256 fingerprint of profile text. */
export function hashProfileText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

const SCORE_CACHE_VERSION = "score-context-v3";

type ScoreCacheKeyInput = {
  profileText: string;
  parsedRole: unknown;
  salary: { min: number; max: number } | null;
  jobLocation?: string | null;
  isRemote?: boolean | null;
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
    isRemote: input.isRemote ?? false,
  });

  return createHash("sha256").update(payload).digest("hex").slice(0, 24);
}

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function scoreColor(score: number | null | undefined): string {
  if (score == null) return "text-slate-400";
  if (score >= 75) return "text-emerald-600";
  if (score >= 50) return "text-amber-600";
  return "text-red-500";
}

export function scoreBg(score: number | null | undefined): string {
  if (score == null) return "bg-slate-100 text-slate-500";
  if (score >= 75) return "bg-emerald-50 text-emerald-700 border border-emerald-200";
  if (score >= 50) return "bg-amber-50 text-amber-700 border border-amber-200";
  return "bg-red-50 text-red-700 border border-red-200";
}

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
    new:          "bg-slate-100 text-slate-600",
    reviewing:    "bg-blue-50 text-blue-700 border border-blue-200",
    shortlisted:  "bg-amber-50 text-amber-700 border border-amber-200",
    contacted:    "bg-violet-50 text-violet-700 border border-violet-200",
    interviewing: "bg-indigo-50 text-indigo-700 border border-indigo-200",
    offer_sent:   "bg-emerald-50 text-emerald-700 border border-emerald-200",
    hired:        "bg-green-100 text-green-800 border border-green-300",
    declined:     "bg-orange-50 text-orange-700 border border-orange-200",
    rejected:     "bg-red-50 text-red-600 border border-red-200",
  };
  return map[status] ?? "bg-slate-100 text-slate-600";
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
