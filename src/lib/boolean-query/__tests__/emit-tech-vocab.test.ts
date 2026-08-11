/**
 * The tsquery emitter must ask the index for technical sentinels, not for the
 * lexemes Postgres's `english` config would produce.
 *
 * Measured on production: `c#` and `c++` BOTH tokenise to 'c', so a C# search
 * returned 5,481 rows of which only 3,383 mentioned C# — the rest were C++ and
 * anything else containing a standalone "c". `.net` tokenises to 'net', which
 * "net profit" also produces.
 *
 * Sentinels are stored in a SEPARATE tsvector component from the english-parsed
 * text (see the searchTsv migration), so their token positions do not line up
 * with the surrounding words. That makes the `<->` adjacency operator wrong for
 * them — a rewritten multi-word term must be AND-ed instead, or it matches
 * nothing at all.
 */
import { describe, it, expect } from "vitest";
import { tsqueryFromParsed, positiveTermAtoms } from "../emit";
import type { ParsedQuery } from "../../boolean-query";

const q = (over: Partial<ParsedQuery> = {}): ParsedQuery =>
  ({ raw: "", mustHave: [], anyOf: [], mustNot: [], ...over }) as ParsedQuery;

describe("tsqueryFromParsed — technical terms become sentinels", () => {
  it("asks for csharpx, not the lexeme 'c', when the recruiter typed C#", () => {
    expect(tsqueryFromParsed(q({ mustHave: ["c#"] }))).toBe("csharpx");
  });

  it("asks for cplusplusx for C++ — a different atom from C#", () => {
    const csharp = tsqueryFromParsed(q({ mustHave: ["c#"] }));
    const cpp = tsqueryFromParsed(q({ mustHave: ["c++"] }));
    expect(cpp).toBe("cplusplusx");
    expect(cpp).not.toBe(csharp);
  });

  it("asks for dotnetx for .NET so it cannot match 'net profit'", () => {
    expect(tsqueryFromParsed(q({ mustHave: [".net"] }))).toBe("dotnetx");
  });

  it("AND-s a rewritten multi-word term instead of using the <-> adjacency operator", () => {
    const out = tsqueryFromParsed(q({ mustHave: [".net core"] })) ?? "";
    expect(out).toContain("dotnetx");
    expect(out).toContain("core");
    expect(out).toContain("&");
    // <-> would require adjacency across two different tsvector components.
    expect(out).not.toContain("<->");
  });

  it("leaves ordinary terms exactly as they were — phrases still use <->", () => {
    expect(tsqueryFromParsed(q({ mustHave: ["react"] }))).toBe("react");
    expect(tsqueryFromParsed(q({ mustHave: ["senior engineer"] }))).toBe("(senior <-> engineer)");
  });

  it("handles a mixed query: a technical term AND an ordinary phrase", () => {
    const out = tsqueryFromParsed(q({ mustHave: ["c#"], anyOf: [["senior engineer"]] })) ?? "";
    expect(out).toContain("csharpx");
    expect(out).toContain("(senior <-> engineer)");
  });

  it("rewrites inside an OR group too", () => {
    const out = tsqueryFromParsed(q({ anyOf: [["c#", "c++"]] })) ?? "";
    expect(out).toContain("csharpx");
    expect(out).toContain("cplusplusx");
    expect(out).toContain("|");
  });

  it("rewrites a negated technical term, so 'NOT C++' excludes C++ and not C#", () => {
    const out = tsqueryFromParsed(q({ mustHave: ["c#"], mustNot: ["c++"] })) ?? "";
    expect(out).toContain("!cplusplusx");
  });

  it("emits nothing tsquery-reserved that would 500 the query", () => {
    for (const term of ["c#", "c++", ".net", "f#", "objective-c", "asp.net", "c#/.net"]) {
      const out = tsqueryFromParsed(q({ mustHave: [term] })) ?? "";
      expect(out).not.toMatch(/[#+\\']/);
      expect(out.length).toBeGreaterThan(0);
    }
  });
});

describe("positiveTermAtoms — coverage scoring uses the same sentinels", () => {
  it("counts a technical term by its sentinel", () => {
    expect(positiveTermAtoms(q({ mustHave: ["c#"] }))).toEqual(["csharpx"]);
  });

  it("keeps C# and C++ as two distinct coverage atoms", () => {
    const atoms = positiveTermAtoms(q({ anyOf: [["c#", "c++"]] }));
    expect(new Set(atoms).size).toBe(2);
  });

  it("is unchanged for ordinary terms", () => {
    expect(positiveTermAtoms(q({ mustHave: ["react", "typescript"] }))).toEqual(["react", "typescript"]);
  });
});
