/**
 * A hunt runs a PORTFOLIO of searches, not one boolean.
 *
 * Modelled directly on a transcript of Anthropic's Claude-in-Chrome sourcing
 * for an "Observability and Networks Manager" role at ACC. It did not run one
 * query; it ran four, each a different angle:
 *
 *     "Network Manager Observability"    broad first pass
 *     "Network Operations Manager"       dedicated network leaders
 *     "Observability Manager"            reliability/observability specialists
 *     "Infrastructure Manager AIOps"     explicit AI-operations experience
 *
 * Two things to copy. First the portfolio itself — one query finds one slice of
 * a market. Second the SHAPE: two or three bare keywords, not a five-phrase
 * quoted OR-group. LinkedIn's basic people-search rewards short keyword queries;
 * it returns nothing for `(titles) AND (skills)` (verified on the box
 * 2026-06-15 and again live 2026-08-12).
 *
 * So these queries are deliberately NOT the boolean the box scraper uses. They
 * are what a recruiter would actually type into the LinkedIn search bar.
 */

import type { ParsedRole } from "@/lib/ai";

export interface HuntQuery {
  /** Exactly what gets typed into LinkedIn's search bar. */
  query: string;
  /** Why this angle is being run — shown to the recruiter before approval. */
  rationale: string;
}

/** Prose-leading words that mark a term as a requirement sentence, not a keyword. */
const PROSE_WORD = /\b(experience|experienced|understanding|knowledge|ability|able|proven|demonstrable|demonstrated|familiar|familiarity|expertise|practical|hands-on|strong|advanced|prior|working|across|managing|exceptional|skilled|track record)\b/i;

/** Normalise a single term: collapse whitespace, trim. */
function normalizeTerm(s: string): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/** Check a term is a short keyword, not prose. */
function isKeywordLike(term: string): boolean {
  const t = normalizeTerm(term);
  if (!t || t.length > 32 || t.includes(",")) return false;
  if (PROSE_WORD.test(t)) return false;
  return t.split(/\s+/).length <= 4;
}

/**
 * Get the "head" of a title — the trailing role noun, e.g.
 * "Observability and Networks Manager" -> "Networks Manager".
 *
 * Trailing words are taken, then any leading connective is stripped. Without
 * that strip, slicing the last three words of the real ACC role produced
 * "and Networks Manager", and the combination angle came out as
 * "and Networks Manager observability" — a query no recruiter would type and
 * LinkedIn would read as noise.
 */
const LEADING_CONNECTIVE = /^(?:and|or|of|for|the|a|an|in|to|with|&)\s+/i;

function titleHead(title: string): string {
  let head = normalizeTerm(title).split(/\s+/).slice(-3).join(" ");
  // Strip repeatedly: "and of Manager" is unlikely but costs nothing to handle.
  let prev = "";
  while (head !== prev) {
    prev = head;
    head = head.replace(LEADING_CONNECTIVE, "").trim();
  }
  return head;
}

/** Build a query from a title plus an anchor term, if valid. */
function combineQuery(title: string, anchor: string): string | null {
  const head = titleHead(title);
  const anchorClean = normalizeTerm(anchor);
  if (!head || !anchorClean || !isKeywordLike(anchorClean)) return null;
  const query = `${head} ${anchorClean}`;
  if (query.split(/\s+/).length > 5) return null;
  return query;
}

/** Validate a query's shape: no quotes/parens/booleans, ≤5 words. */
function isValidQuery(query: string): boolean {
  if (!query) return false;
  if (/["()]/.test(query)) return false;
  if (/\b(AND|OR|NOT)\b/.test(query)) return false;
  return query.split(/\s+/).length <= 5;
}

/** De-duplicate case-insensitively, preserving order. */
function dedupe(queries: HuntQuery[]): HuntQuery[] {
  const seen = new Set<string>();
  const out: HuntQuery[] = [];
  for (const q of queries) {
    const key = q.query.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(q);
    }
  }
  return out;
}

/**
 * Build a portfolio of short LinkedIn search queries for a role.
 *
 * A hunt runs several short keyword searches (never one big boolean) — each
 * query targets a different slice of the candidate market, the way a recruiter
 * would actually search. The role's own title leads, then synonyms, then
 * title-head + anchor combinations, capped at 6 total.
 */
export function buildHuntQueries(role: ParsedRole): HuntQuery[] {
  // Never throw — guard against malformed input.
  const title = normalizeTerm(role?.title ?? "");
  if (!title) return [];

  const queries: HuntQuery[] = [];

  // 1. The role's own title.
  if (isValidQuery(title)) {
    queries.push({ query: title, rationale: "The role's own title" });
  }

  // 2. Synonym titles.
  const synonyms = Array.isArray(role?.synonym_titles) ? role.synonym_titles : [];
  for (const syn of synonyms) {
    const s = normalizeTerm(syn);
    if (s && isValidQuery(s)) {
      queries.push({ query: s, rationale: "Alternative title candidates use" });
    }
  }

  // 3. Combination angles: title head + anchor term.
  const anchors = Array.isArray(role?.anchor_terms) ? role.anchor_terms : [];
  for (const anchor of anchors) {
    const combined = combineQuery(title, anchor);
    if (combined && isValidQuery(combined)) {
      queries.push({ query: combined, rationale: "Title plus a distinctive skill" });
    }
  }

  // Cap at 6, de-duplicate.
  return dedupe(queries).slice(0, 6);
}
