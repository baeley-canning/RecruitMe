/**
 * Talent-flywheel READ-PATH: re-rank library-search results using the
 * structured ProfileInsight facts (primaryStack / titlesHeld / domains / …)
 * extracted earlier. This is the "Stage-1 ranker uses insight signals" hook.
 *
 * Design constraints (this touches CORE SEARCH — keep it surgical):
 *  • Pure functions + a thin DB batch-read; NO change to the FTS SQL, the
 *    searchTsv column, or any index (a prior architecture review warned
 *    against index changes here).
 *  • It is a NUDGE, not a re-sort: the SQL order stays the dominant signal
 *    (baseRank = N-index) and an insight match can only lift a candidate a
 *    bounded number of positions. A bottom result can never leap to the top.
 *  • Exact no-op when there are no positive query terms OR no insights match
 *    — `rerankByInsights` then returns the input order unchanged (stable).
 *  • Gated by RECRUITME_PROFILE_INSIGHT_READ_ENABLED at the call site.
 */

import type { ParsedQuery } from "../boolean-query";
import type { InsightFacts } from "../ai/insights";

/** Max positions a full (fraction=1.0) insight match can climb. Small enough
 *  that ranking stays SQL-driven; large enough to break real ties. */
export const INSIGHT_BOOST_POSITIONS = 8;

/** Lowercased positive terms from the query — every mustHave term and every
 *  member of every anyOf group, de-duped. (mustNot is excluded by design.) */
export function positiveQueryTerms(q: ParsedQuery): string[] {
  const out = new Set<string>();
  const add = (t: string) => { const v = t.trim().toLowerCase(); if (v) out.add(v); };
  for (const t of q.mustHave) add(t);
  for (const g of q.anyOf) for (const t of g) add(t);
  return [...out];
}

// Tokeniser that keeps #, +, . inside tokens so "c#", "c++", ".net",
// "node.js" survive as single tokens — single-word query terms are matched by
// token EQUALITY (so "java" does not match "javascript"); multi-word phrases
// fall back to substring containment.
function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9#+.]+/g) ?? [];
}

/** Fraction (0..1) of the query's positive terms that the candidate's
 *  structured insight facts support. 0 when there are no terms. */
export function insightMatchFraction(terms: string[], facts: InsightFacts): number {
  if (terms.length === 0) return 0;
  const entries = [
    facts.currentTitle,
    facts.currentEmployer,
    ...facts.primaryStack,
    ...facts.secondaryStack,
    ...facts.titlesHeld,
    ...facts.domains,
    ...facts.certifications,
  ].filter((x): x is string => !!x).map((x) => x.toLowerCase());

  const tokenSet = new Set<string>();
  for (const e of entries) for (const tok of tokenize(e)) tokenSet.add(tok);
  const joined = entries.join(" | ");

  let matched = 0;
  for (const term of terms) {
    const hit = term.includes(" ") ? joined.includes(term) : tokenSet.has(term);
    if (hit) matched++;
  }
  return matched / terms.length;
}

/**
 * Re-rank SQL-ordered rows by insight match, preserving the SQL order as the
 * dominant signal. Returns the rows unchanged when there's nothing to nudge.
 */
export function rerankByInsights<T extends { candidateIdentityId: string | null }>(
  rows: T[],
  terms: string[],
  factsById: Map<string, InsightFacts>,
): T[] {
  if (terms.length === 0 || factsById.size === 0 || rows.length === 0) return rows;
  const n = rows.length;
  const scored = rows.map((row, index) => {
    const baseRank = n - index; // top row = n, last = 1 → SQL order dominates
    const facts = row.candidateIdentityId ? factsById.get(row.candidateIdentityId) : undefined;
    const boost = facts ? insightMatchFraction(terms, facts) * INSIGHT_BOOST_POSITIONS : 0;
    return { row, score: baseRank + boost, index };
  });
  // Stable: equal scores (incl. the all-zero-boost case) keep original order.
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((s) => s.row);
}
