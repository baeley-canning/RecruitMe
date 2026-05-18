/**
 * Pure helpers for the contact-sheet sync. Zero I/O. All side-effect-
 * free so the sync planner is fully unit-testable.
 */

import { normaliseLinkedInUrl } from "../linkedin";

// ─── Status mapping ────────────────────────────────────────────────────────

/**
 * Map a free-form Status cell from the sheet to a target RecruitMe
 * Candidate.status, or `null` when the sheet status doesn't drive any
 * status change (the row may still produce a ContactEvent).
 *
 * Returning `null` is different from "unknown" — known-no-op values
 * like "Interested" leave status alone so the recruiter can manually
 * progress the candidate without the sheet stomping on it.
 *
 * Order matters: longer phrases first so "not interested in role" beats
 * the generic "interested" prefix.
 */
export function mapSheetStatusToCandidateStatus(rawStatus: string): {
  /** "contacted" | "declined" | null (no change) | "unknown" (unmapped). */
  mapped: "contacted" | "declined" | "no_change" | "unknown";
  /** Whether this row should produce a ContactEvent. */
  isContactTouch: boolean;
} {
  const s = rawStatus.trim().toLowerCase();
  if (!s) return { mapped: "no_change", isContactTouch: false };
  // Not-interested family (longest prefix wins so we don't accidentally
  // match the generic "interested" inside "not interested").
  if (
    s.includes("not interested") ||
    s.includes("not looking") ||
    s.includes("declined") ||
    s === "no"
  ) {
    return { mapped: "declined", isContactTouch: false };
  }
  // Outreach-sent family — the candidate has been touched, awaiting reply.
  if (s.includes("jd sent") || s.includes("message sent") || s.includes("outreach") || s === "contacted") {
    return { mapped: "contacted", isContactTouch: true };
  }
  // Interested-but-not-yet-progressed — recruiter advances manually.
  if (s.includes("interested") || s.includes("replied") || s.includes("call booked")) {
    return { mapped: "no_change", isContactTouch: true };
  }
  return { mapped: "unknown", isContactTouch: false };
}

// ─── Status protection ────────────────────────────────────────────────────

/**
 * Pipeline states we NEVER overwrite from the sheet. Once the recruiter
 * has manually moved a candidate into one of these stages in RecruitMe,
 * a stale "JD sent" row in the sheet shouldn't downgrade them back to
 * "contacted".
 */
const PROTECTED_STATUSES = new Set([
  "shortlisted",
  "interviewing",
  "offer_sent",
  "hired",
]);

export function isProtectedStatus(current: string): boolean {
  return PROTECTED_STATUSES.has(current);
}

// ─── Title fuzzy matching ─────────────────────────────────────────────────

/**
 * Token-overlap match between a sheet tab name and a Job.title.
 * Returns a score 0..1; ≥0.7 is treated as a confident match.
 *
 * Designed for typical real-world variation:
 *   "Sr. Full Stack Dev"        ↔ "Senior Full-Stack Developer"
 *   "Technical Support Engineer ADR" ↔ "Technical Support & Sales Engineer – Power & SCADA"
 *
 * Punctuation, common short-forms, and case are normalised before the
 * Jaccard-style overlap on the token sets.
 */
const ABBREVIATIONS: Record<string, string> = {
  sr: "senior",
  jr: "junior",
  dev: "developer",
  eng: "engineer",
  mgr: "manager",
  pm: "project manager",
  qa: "quality assurance",
  ui: "user interface",
  ux: "user experience",
  rfi: "request information",
  rfp: "request proposal",
};

function tokeniseTitle(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")     // strip punctuation
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((tok) => ABBREVIATIONS[tok]?.split(" ") ?? [tok])
    .filter((tok) => tok.length > 1 || tok.match(/^\d+$/)); // drop single letters except digits
}

/** Public: compute similarity in [0, 1] between two titles. */
export function titleSimilarity(a: string, b: string): number {
  const ta = new Set(tokeniseTitle(a));
  const tb = new Set(tokeniseTitle(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap++;
  // Use the smaller set as denominator so a long RecruitMe title doesn't
  // penalise a terse sheet tab. Equivalent to overlap / min(|A|,|B|).
  return overlap / Math.min(ta.size, tb.size);
}

/**
 * Match a tab name to the best Job, with a threshold and tie-aware
 * rejection. Returns the unambiguous winner or null.
 */
export function pickBestJob(
  tabName: string,
  jobs: Array<{ id: string; title: string }>,
  threshold = 0.7,
): { id: string; title: string; score: number } | null {
  const scored = jobs.map((job) => ({ ...job, score: titleSimilarity(tabName, job.title) }));
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  if (!top || top.score < threshold) return null;
  // Reject if a second candidate is within 10% — too ambiguous to pick.
  const runnerUp = scored[1];
  if (runnerUp && top.score - runnerUp.score < 0.1) return null;
  return top;
}

// ─── URL + date helpers ───────────────────────────────────────────────────

/** Returns "" when the cell doesn't contain a usable LinkedIn URL. */
export function normaliseSheetLinkedInUrl(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "";
  if (!/linkedin\.com\/in\//i.test(trimmed)) return "";
  return normaliseLinkedInUrl(trimmed);
}

/** Best-effort date parsing — tolerates `2026-05-10`, `10/05/2026`,
 *  `10 May 2026`. Slash/dash separators are interpreted as DMY (NZ/AU
 *  convention) BEFORE native Date parsing, since JS Date defaults to
 *  US MDY for slash dates and would swap day/month for an NZ recruiter. */
export function parseLastContactedCell(raw: string): Date | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  // DMY first — guards against JS Date's US-MDY default for slash dates.
  // Construct as UTC midnight so toISOString().slice(0, 10) round-trips
  // back to the same date regardless of the server's local timezone.
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]) - 1;
    const yearRaw = Number(dmy[3]);
    const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
    const d = new Date(Date.UTC(year, month, day));
    if (!Number.isNaN(d.getTime())) return d;
  }
  // ISO + textual ("10 May 2026") — handled by native Date.
  const direct = new Date(s);
  if (!Number.isNaN(direct.getTime())) return direct;
  return null;
}
