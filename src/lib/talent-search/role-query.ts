/**
 * parsedRoleToBooleanQuery — turn a parsed job role into ONE boolean query so
 * the jobs-area "Find Candidates" can search straight from the role with no
 * boolean typed by hand. The shape is:
 *
 *   ("<Title>" OR "<Synonym 1>" OR …) AND ("<anchor 1>" OR "<anchor 2>" …)
 *
 * Title-group OR-widens across the role's title + alternative titles; the
 * anchor group is ALSO OR'd (require AT LEAST ONE distinctive signal, not all
 * of them) — hard-AND-ing every anchor makes the library FTS require every
 * term simultaneously and returns near-zero on real profiles. Conservative
 * slices (≤5 titles, ≤3 anchors) keep it from over-widening; the recruiter can
 * still tweak it via the modal's "Refine" field. Pure + deterministic — no
 * scoring/network. Every term is quote-wrapped so a bareword can never be read
 * as a boolean operator (AND/OR/NOT), a negation (leading "-"), or split on a
 * paren — and the output always parses via parseBooleanQuery (round-trip
 * tested).
 */

import type { ParsedRole } from "@/lib/ai";

/** Term-level normalisation ONLY — collapse whitespace + drop a stray `site:`
 *  prefix. Deliberately NOT cleanQuery(): that scrubs a whole free-text query
 *  and strips "<n> years" / the word "location", which are legitimate inside a
 *  single title or skill ("Location Manager", "5+ years React"). */
function normalizeTerm(s: string): string {
  return (s ?? "").replace(/^site:\S+\s*/i, "").replace(/\s+/g, " ").trim();
}

/** Strip parser-reserved characters then ALWAYS quote-wrap, so a single-word
 *  term that happens to be an operator word, start with "-", or contain parens
 *  can't corrupt the boolean (negate a required term, drop a term, or split). */
function quoteTerm(s: string): string {
  const cleaned = s.replace(/["()]/g, "").replace(/^-+/, "").replace(/\s+/g, " ").trim();
  return cleaned ? `"${cleaned}"` : "";
}

function uniqueTerms(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const c = normalizeTerm(v);
    const key = c.toLowerCase();
    if (c && !seen.has(key)) { seen.add(key); out.push(c); }
  }
  return out;
}

// Search anchors must be SHORT KEYWORDS, not prose requirements. must_haves (and
// occasionally anchor_terms) come back from the parser as full requirement
// SENTENCES — "Experience with ITSM tools", "Understanding of ITIL service
// management practices", "Experience in service transition, IT operations, or
// endpoint management". Quoting those as FTS / SEEK / LinkedIn phrases matches
// ~nothing, so the whole search returns 0 EVERYWHERE (lib + SEEK + LinkedIn — the
// "no results at all" bug). Reject sentence-shaped terms (long, comma'd, or
// prose-led); when none survive, the search is title-only — broad, but it returns
// real people instead of nothing. Real skill anchors ("Silverstripe", "Vue.js",
// "ServiceNow", "ITIL", "service transition") sail through.
const PROSE_WORD = /\b(experience|experienced|understanding|knowledge|ability|able|proven|demonstrable|demonstrated|familiar|familiarity|expertise|practical|hands-on|strong|advanced|prior|working|across|managing|exceptional|skilled|track record)\b/i;
function isKeywordLike(term: string): boolean {
  const t = term.trim();
  if (!t || t.length > 32 || t.includes(",")) return false;
  if (PROSE_WORD.test(t)) return false;
  return t.split(/\s+/).length <= 4;
}

/** OR-group a list of already-normalised terms into a single boolean group. */
function orGroup(terms: string[]): string {
  const quoted = terms.map(quoteTerm).filter(Boolean);
  if (quoted.length === 0) return "";
  if (quoted.length === 1) return quoted[0];
  return `(${quoted.join(" OR ")})`;
}

export function parsedRoleToBooleanQuery(role: ParsedRole): string {
  // Title OR-group: the role's title + alternative titles it could go by.
  const titles = uniqueTerms([role.title, ...(role.synonym_titles ?? [])]).slice(0, 5);
  // Anchor signals: the rare/hard skills. Prefer anchor_terms; fall back to
  // must_haves for roles parsed before anchor_terms existed.
  const usingAnchorTerms = (role.anchor_terms?.length ?? 0) > 0;
  const anchorSource = usingAnchorTerms ? role.anchor_terms! : (role.must_haves ?? []);
  // Keyword-like only — drop prose must_haves/anchors that would 0 the search.
  const anchors = uniqueTerms(anchorSource).filter(isKeywordLike).slice(0, 3);

  const titleGroup = orGroup(titles);

  const parts: string[] = [];
  if (titleGroup) parts.push(titleGroup);

  // When the AI certified a rare distinctive anchor (anchor_terms non-empty), it
  // has guaranteed there's a single dominant must-have — so REQUIRE the top one
  // (hard AND) and keep the rest OR'd. That's the "a Silverstripe role returns
  // Silverstripe devs, not anyone who clipped one OR'd skill" fix. When we fell
  // back to must_haves (anchor_terms empty = hybrid/ambiguous role), keep
  // everything OR'd — those terms AND-to-zero. searchLibrary RELAXES the hard
  // requirement automatically if it would otherwise yield zero results, so a
  // tokenisation miss can't dead-end the recruiter.
  if (usingAnchorTerms && anchors.length > 0) {
    parts.push(quoteTerm(anchors[0]));        // hard-required dominant skill
    const rest = orGroup(anchors.slice(1));   // remaining anchors stay optional
    if (rest) parts.push(rest);
  } else {
    const anchorGroup = orGroup(anchors);
    if (anchorGroup) parts.push(anchorGroup);
  }

  const query = parts.join(" AND ");
  // Fallback: a bare quoted title, else empty (caller treats empty as
  // "fall back to manual entry").
  return query || quoteTerm(normalizeTerm(role.title ?? "")) || "";
}
