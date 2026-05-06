/**
 * Recruiter Memory — inject past hiring decisions into candidate scoring.
 *
 * When scoring a new candidate, we retrieve similar past decisions from the
 * same org and include them as examples in the scoring prompt. Claude then
 * sees what "good" and "bad" look like for THIS organisation, not just the
 * generic scoring rubric.
 *
 * No vector database needed. We use simple role-similarity matching
 * (title keyword overlap + must-have overlap) to find relevant examples.
 */

import { prisma } from "./db";
import { safeParseJson } from "./utils";
import type { ParsedRole } from "./ai";
import type { ScoreBreakdown } from "./scoring";

const POSITIVE_STATUSES = new Set(["shortlisted", "contacted", "interviewing", "offer_sent", "hired"]);
const NEGATIVE_STATUSES = new Set(["rejected", "declined"]);

// Minimum chars of profile text to use as an example — short profiles
// don't provide enough signal for meaningful examples.
const MIN_EXAMPLE_PROFILE_CHARS = 500;

interface RecruiterExample {
  name: string;         // initials only e.g. "J.P."
  headline: string;
  outcome: "positive" | "negative";
  outcomeLabel: string; // "Hired", "Shortlisted", "Rejected" etc.
  reasonsFor: string[];
  reasonsAgainst: string[];
  summary: string;
  roleTitle: string;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() + ".")
    .join("") || "?";
}

function titleSimilarity(a: string, b: string): number {
  const tokenise = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3);
  const ta = new Set(tokenise(a));
  const tb = new Set(tokenise(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  const intersection = [...ta].filter((w) => tb.has(w)).length;
  return intersection / Math.max(ta.size, tb.size);
}

function mustHaveSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const tokenise = (items: string[]) =>
    new Set(items.flatMap((s) =>
      s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2)
    ));
  const ta = tokenise(a);
  const tb = tokenise(b);
  const intersection = [...ta].filter((w) => tb.has(w)).length;
  return intersection / Math.max(ta.size, tb.size);
}

export async function getRecruitingContext(
  parsedRole: ParsedRole,
  orgId: string | null,
): Promise<string> {
  if (!orgId) return "";

  // Pull recent decided candidates from this org that have been AI-scored.
  const candidates = await prisma.candidate.findMany({
    where: {
      orgId,
      status: { in: [...POSITIVE_STATUSES, ...NEGATIVE_STATUSES] },
      scoreBreakdown: { not: null },
    },
    select: {
      name: true,
      headline: true,
      status: true,
      scoreBreakdown: true,
      profileText: true,
      job: { select: { parsedRole: true, title: true } },
    },
    orderBy: { updatedAt: "desc" },
    take: 200, // look at the last 200 decisions, then rank by similarity
  });

  if (candidates.length === 0) return "";

  // Score each candidate by role similarity
  const mustHaves = parsedRole.must_haves ?? [];
  const scored = candidates
    .filter((c) => (c.profileText?.length ?? 0) >= MIN_EXAMPLE_PROFILE_CHARS)
    .map((c) => {
      const jobParsed = safeParseJson<ParsedRole | null>(c.job?.parsedRole ?? null, null);
      const titleSim  = titleSimilarity(parsedRole.title, c.job?.title ?? "");
      const skillSim  = mustHaveSimilarity(mustHaves, jobParsed?.must_haves ?? []);
      return { ...c, similarity: titleSim * 0.4 + skillSim * 0.6 };
    })
    .filter((c) => c.similarity > 0.1) // must have some relevance
    .sort((a, b) => b.similarity - a.similarity);

  if (scored.length === 0) return "";

  // Take up to 3 positive and 2 negative examples
  const positives = scored.filter((c) => POSITIVE_STATUSES.has(c.status)).slice(0, 3);
  const negatives = scored.filter((c) => NEGATIVE_STATUSES.has(c.status)).slice(0, 2);
  const examples  = [...positives, ...negatives];

  if (examples.length === 0) return "";

  const formatted: RecruiterExample[] = examples.map((c) => {
    const bd = safeParseJson<ScoreBreakdown | null>(c.scoreBreakdown ?? null, null);
    return {
      name:          initials(c.name),
      headline:      c.headline ?? "No headline",
      outcome:       POSITIVE_STATUSES.has(c.status) ? "positive" : "negative",
      outcomeLabel:  c.status === "hired" ? "Hired" : c.status === "rejected" ? "Rejected" :
                     c.status === "declined" ? "Declined" :
                     c.status === "shortlisted" ? "Shortlisted" : "Advanced",
      reasonsFor:    (bd?.reasons_for ?? []).slice(0, 2),
      reasonsAgainst:(bd?.reasons_against ?? []).slice(0, 2),
      summary:       bd?.recruiter_summary ?? "",
      roleTitle:     c.job?.title ?? "Similar role",
    };
  });

  const lines: string[] = [
    "Past hiring decisions for similar roles in this organisation:",
    "(Use these to calibrate your score — they reflect what this org actually values.)",
    "",
  ];

  for (const ex of formatted) {
    const sign = ex.outcome === "positive" ? "✓" : "✗";
    lines.push(`${sign} ${ex.outcomeLabel.toUpperCase()} — ${ex.name} (${ex.roleTitle})`);
    lines.push(`  Headline: ${ex.headline}`);
    if (ex.summary) lines.push(`  Assessment: ${ex.summary}`);
    if (ex.reasonsFor.length)     lines.push(`  Strengths: ${ex.reasonsFor.join("; ")}`);
    if (ex.reasonsAgainst.length) lines.push(`  Gaps: ${ex.reasonsAgainst.join("; ")}`);
    lines.push("");
  }

  return lines.join("\n");
}
