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
import { escapeXmlForPrompt } from "./profile-excerpt";
import type { ParsedRole } from "./ai";
import type { ScoreBreakdown } from "./scoring";

const POSITIVE_STATUSES = new Set(["shortlisted", "contacted", "interviewing", "offer_sent", "hired"]);
const NEGATIVE_STATUSES = new Set(["rejected", "declined"]);

// Minimum chars of profile text to use as an example — short profiles
// don't provide enough signal for meaningful examples.
const MIN_EXAMPLE_PROFILE_CHARS = 500;

// Bound on how many corrections we pull and inject. Each correction line is ~180
// chars; with reason-truncation that's <2k chars in the prompt — well inside
// the budget but still useful as calibration signal. Lowered from 4 → 10
// (top-N after similarity filter) and 50 → 20 (DB pull) to also defend against
// recruiters or compromised accounts spamming corrections to bias scoring.
const MAX_CORRECTIONS_PULLED = 20;
const MAX_CORRECTIONS_INJECTED = 10;
const MAX_CORRECTION_REASON_CHARS = 200;

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
  // Preserve + and # so technical terms like C++ and C# survive tokenisation.
  // Length floor lowered to 2 so short critical terms (Go, C#) aren't filtered.
  const tokenise = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9+# ]/g, " ").split(/\s+/).filter((w) => w.length > 1);
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
  let candidates;
  try {
    candidates = await prisma.candidate.findMany({
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
      updatedAt: true,
      job: { select: { parsedRole: true, title: true, company: true } },
    },
    orderBy: { updatedAt: "desc" },
    take: 200, // look at the last 200 decisions, then rank by similarity
  });
  } catch (err) {
    console.warn("[recruiter-memory] DB query failed:", err instanceof Error ? err.message : err);
    return "";
  }

  if (candidates.length === 0) return "";

  const now = Date.now();
  const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;

  // Score each candidate by role similarity with recency decay.
  // Examples older than 60 days are down-weighted (0.75×) so stale patterns
  // don't lock in company or domain preferences from old roles.
  const mustHaves = parsedRole.must_haves ?? [];
  const scored = candidates
    .filter((c) => (c.profileText?.length ?? 0) >= MIN_EXAMPLE_PROFILE_CHARS)
    .map((c) => {
      const jobParsed  = safeParseJson<ParsedRole | null>(c.job?.parsedRole ?? null, null);
      const titleSim   = titleSimilarity(parsedRole.title, c.job?.title ?? "");
      const skillSim   = mustHaveSimilarity(mustHaves, jobParsed?.must_haves ?? []);
      const ageMs      = now - new Date(c.updatedAt).getTime();
      const recencyMod = ageMs > SIXTY_DAYS_MS ? 0.75 : 1.0;
      return { ...c, similarity: (titleSim * 0.4 + skillSim * 0.6) * recencyMod };
    })
    .filter((c) => c.similarity > 0.25) // meaningful overlap required — 0.1 was too permissive
    .sort((a, b) => b.similarity - a.similarity);

  if (scored.length === 0) return "";

  // Take up to 3 positive and 2 negative examples.
  // Deduplication: cap to 1 positive per company so a single employer that
  // the org consistently hires from doesn't dominate the context and introduce
  // employer bias into future scoring.
  const seenCompany = new Set<string>();
  const positives: typeof scored = [];
  for (const c of scored.filter((c) => POSITIVE_STATUSES.has(c.status))) {
    // Use a sentinel for null/empty company so anonymous-company candidates
    // also get deduplicated (only 1 positive example per "unknown" employer).
    const company = (c.job?.company?.trim() ? c.job.company.toLowerCase().trim() : "__unknown__");
    if (seenCompany.has(company)) continue;
    seenCompany.add(company);
    positives.push(c);
    if (positives.length >= 3) break;
  }
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
    // All user-controlled fields are XML-escaped: a candidate name, headline,
    // recruiter_summary, or reasons_for/against value containing prompt-injection
    // payload (e.g. </candidate_profile> tags) would otherwise break out of the
    // XML wrapper around the candidate-being-scored further down the prompt.
    lines.push(`${sign} ${ex.outcomeLabel.toUpperCase()} — ${escapeXmlForPrompt(ex.name)} (${escapeXmlForPrompt(ex.roleTitle)})`);
    lines.push(`  Headline: ${escapeXmlForPrompt(ex.headline)}`);
    if (ex.summary) lines.push(`  Assessment: ${escapeXmlForPrompt(ex.summary)}`);
    if (ex.reasonsFor.length)     lines.push(`  Strengths: ${ex.reasonsFor.map(escapeXmlForPrompt).join("; ")}`);
    if (ex.reasonsAgainst.length) lines.push(`  Gaps: ${ex.reasonsAgainst.map(escapeXmlForPrompt).join("; ")}`);
    lines.push("");
  }

  // ── Score corrections — explicit "the AI got this wrong" signal ─────────────
  // Pulled in addition to status-based examples so the AI sees not just *who*
  // succeeded/failed but *where its own scoring drifted from the recruiter's*.
  // All user-controlled fields (roleTitle, headline, reason) flow through
  // escapeXmlForPrompt to prevent prompt-injection via free-text correction
  // reasons.
  try {
    const corrections = await prisma.scoreCorrection.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
      take: MAX_CORRECTIONS_PULLED,
      select: {
        originalScore: true,
        recruiterScore: true,
        reason: true,
        roleTitle: true,
        candidate: { select: { headline: true, name: true } },
      },
    });
    const relevant = corrections
      .map((c) => ({ ...c, sim: titleSimilarity(parsedRole.title, c.roleTitle ?? "") }))
      .filter((c) => c.sim > 0.25)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, MAX_CORRECTIONS_INJECTED);

    if (relevant.length > 0) {
      lines.push("Score corrections (this org explicitly told us when our scoring was off — apply the same direction here):");
      lines.push("");
      for (const c of relevant) {
        const direction = c.recruiterScore < c.originalScore ? "down" : "up";
        const delta = Math.abs(c.recruiterScore - c.originalScore);
        const safeRole = escapeXmlForPrompt(c.roleTitle ?? "similar role");
        const safeName = escapeXmlForPrompt(initials(c.candidate.name));
        lines.push(`• ${safeName} (${safeRole}): we said ${c.originalScore}, recruiter said ${c.recruiterScore} (${direction} ${delta} pts)`);
        if (c.candidate.headline) {
          lines.push(`  Headline: ${escapeXmlForPrompt(c.candidate.headline)}`);
        }
        if (c.reason) {
          // Truncate then escape so a malicious 50KB reason can't inflate the prompt.
          const truncated = c.reason.length > MAX_CORRECTION_REASON_CHARS
            ? `${c.reason.slice(0, MAX_CORRECTION_REASON_CHARS)}…`
            : c.reason;
          lines.push(`  Reason: ${escapeXmlForPrompt(truncated)}`);
        }
      }
      lines.push("");
    }
  } catch (err) {
    console.warn("[recruiter-memory] correction query failed:", err instanceof Error ? err.message : err);
  }

  return lines.join("\n");
}
