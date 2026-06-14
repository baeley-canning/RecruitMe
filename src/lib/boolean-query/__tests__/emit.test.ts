/**
 * Tests for the per-backend AST emitters (Phase F). These are pure
 * functions over a ParsedQuery — easy to pin completely.
 */

import { describe, expect, it } from "vitest";
import { parseBooleanQuery } from "../../boolean-query";
import {
  tsqueryFromParsed,
  positiveTermAtoms,
  seekKeywordsFromParsed,
  linkedinKeywordsFromParsed,
  linkedinTitleQuery,
} from "../emit";

describe("positiveTermAtoms", () => {
  it("flattens mustHave + every anyOf member into distinct atoms (for coverage)", () => {
    const atoms = positiveTermAtoms(parseBooleanQuery('"senior developer" AND (silverstripe OR vue OR react)'));
    expect(atoms).toEqual(["(senior <-> developer)", "silverstripe", "vue", "react"]);
  });

  it("de-dupes and excludes negations", () => {
    const atoms = positiveTermAtoms(parseBooleanQuery("react OR react NOT contractor"));
    expect(atoms).toEqual(["react"]);
  });

  it("empty query → no atoms", () => {
    expect(positiveTermAtoms(parseBooleanQuery(""))).toEqual([]);
  });
});

describe("tsqueryFromParsed", () => {
  it("empty query → null (signal to skip the FTS predicate)", () => {
    expect(tsqueryFromParsed(parseBooleanQuery(""))).toBeNull();
  });

  it("single term → bare lexeme", () => {
    expect(tsqueryFromParsed(parseBooleanQuery("python"))).toBe("python");
  });

  it("two AND terms → `&`-joined", () => {
    expect(tsqueryFromParsed(parseBooleanQuery("python senior"))).toBe("python & senior");
  });

  it("OR group → parenthesised with `|`", () => {
    expect(tsqueryFromParsed(parseBooleanQuery('"java" OR "python"'))).toBe("(java | python)");
  });

  it("phrase → <-> followed-by inside parens", () => {
    expect(tsqueryFromParsed(parseBooleanQuery('"machine learning"'))).toBe("(machine <-> learning)");
  });

  it("must-not → leading !", () => {
    expect(tsqueryFromParsed(parseBooleanQuery("senior NOT junior"))).toBe("senior & !junior");
  });

  it("negation-only query → null (lone !x is a corpus-complement scan; caller falls back to recency)", () => {
    const notKeyword = parseBooleanQuery("NOT intern");
    expect(notKeyword.mustHave).toHaveLength(0);
    expect(notKeyword.anyOf).toHaveLength(0);
    expect(notKeyword.mustNot).toEqual(["intern"]);
    expect(tsqueryFromParsed(notKeyword)).toBeNull();

    // The `-` shorthand and multiple negations are also negation-only.
    expect(tsqueryFromParsed(parseBooleanQuery("-intern"))).toBeNull();
    expect(tsqueryFromParsed(parseBooleanQuery("NOT intern NOT junior"))).toBeNull();
  });

  it("positives + negation still emit normally (regression for the negation-only fix)", () => {
    expect(tsqueryFromParsed(parseBooleanQuery("python NOT intern"))).toBe("python & !intern");
    expect(tsqueryFromParsed(parseBooleanQuery('("java" OR "python") NOT intern'))).toBe(
      "(java | python) & !intern",
    );
  });

  it("strips tsquery-reserved chars from user terms", () => {
    // `:`, `*`, `&`, `|` would inject operators if passed raw.
    expect(tsqueryFromParsed(parseBooleanQuery("c:*"))).not.toContain(":");
    expect(tsqueryFromParsed(parseBooleanQuery("c:*"))).not.toContain("*");
  });
});

describe("seekKeywordsFromParsed", () => {
  it("uppercase operators + quoted phrases", () => {
    const q = parseBooleanQuery('("java" OR "python") AND senior NOT junior "machine learning"');
    const out = seekKeywordsFromParsed(q);
    expect(out).toContain("AND");
    expect(out).toContain("OR");
    expect(out).toContain("NOT junior");
    expect(out).toContain('"machine learning"');
  });
});

describe("linkedinKeywordsFromParsed", () => {
  it("strips wildcards", () => {
    const q = parseBooleanQuery('senior* python');
    const out = linkedinKeywordsFromParsed(q);
    expect(out).not.toContain("*");
    expect(out).toContain("senior");
    expect(out).toContain("python");
  });

  it("quotes multi-word phrases", () => {
    const q = parseBooleanQuery('"machine learning"');
    const out = linkedinKeywordsFromParsed(q);
    expect(out).toContain('"machine learning"');
  });

  it("strips .js/.ts framework suffixes (LinkedIn matches them literally → 0 hits)", () => {
    // Verified on the box 2026-06-15: `(react.js OR vue.js)` returned 0,
    // `(react OR vue)` returned ~33. So drop the dotted suffix for LinkedIn.
    const q = parseBooleanQuery('"react.js" OR "vue.js" OR node.js');
    const out = linkedinKeywordsFromParsed(q);
    expect(out).not.toContain(".js");
    expect(out).toContain("react");
    expect(out).toContain("vue");
    expect(out).toContain("node");
  });
});

describe("linkedinTitleQuery", () => {
  it("single title → one quoted phrase", () => {
    expect(linkedinTitleQuery(["Service Transition Manager"])).toBe('"Service Transition Manager"');
  });

  it("multiple titles → OR-group (no skill AND — LinkedIn basic search 0s on that)", () => {
    const out = linkedinTitleQuery(["Full Stack Developer", "Software Engineer", "Web Developer"]);
    expect(out).toBe('("Full Stack Developer" OR "Software Engineer" OR "Web Developer")');
    expect(out).not.toContain(" AND ");
  });

  it("dedupes case-insensitively, drops blanks/quotes, caps the list", () => {
    const out = linkedinTitleQuery(["Dev", "dev", "", '"Lead"', "A", "B", "C", "D", "E", "F"], 6);
    // dedupe Dev/dev → one; quote stripped from "Lead"; capped at 6 distinct
    expect(out.match(/ OR /g)?.length).toBe(5); // 6 terms → 5 ORs
    expect(out).toContain('"Dev"');
    expect(out).toContain('"Lead"');
  });

  it("no usable titles → empty string (caller falls back)", () => {
    expect(linkedinTitleQuery([])).toBe("");
    expect(linkedinTitleQuery(["", "  "])).toBe("");
  });
});
