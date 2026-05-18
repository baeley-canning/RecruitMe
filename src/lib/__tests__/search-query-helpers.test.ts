import { describe, expect, it } from "vitest";
import {
  looksReal,
  looksLikePersonName,
  cleanQuery,
  dedupeQueries,
} from "../search-query-helpers";

describe("looksReal", () => {
  it("rejects bracketed templates", () => {
    expect(looksReal("[Full Name]")).toBe(false);
    expect(looksReal("[unknown]")).toBe(false);
  });

  it("rejects known placeholder strings (case-insensitive)", () => {
    expect(looksReal("Full Name")).toBe(false);
    expect(looksReal("UNKNOWN")).toBe(false);
    expect(looksReal("see profile")).toBe(false);
  });

  it("rejects too-short or too-long strings", () => {
    expect(looksReal("AB")).toBe(false);
    expect(looksReal("x".repeat(101))).toBe(false);
  });

  it("accepts plausible real names", () => {
    expect(looksReal("Jane Smith")).toBe(true);
    expect(looksReal("Aroha Te Kanawa")).toBe(true);
  });
});

describe("looksLikePersonName", () => {
  it("rejects company / org patterns", () => {
    expect(looksLikePersonName("Acme Limited")).toBe(false);
    expect(looksLikePersonName("Auckland University")).toBe(false);
    expect(looksLikePersonName("Ministry of Health")).toBe(false);
    expect(looksLikePersonName("Wellington Regional Council")).toBe(false);
  });

  it("accepts 2–6 word names", () => {
    expect(looksLikePersonName("Jane Smith")).toBe(true);
    expect(looksLikePersonName("Mary Jane Smith")).toBe(true);
  });

  it("rejects single-word and 7+ word strings", () => {
    expect(looksLikePersonName("Jane")).toBe(false);
    expect(looksLikePersonName("Jane Smith Jane Smith Jane Smith Jane")).toBe(false);
  });
});

describe("cleanQuery", () => {
  it("strips site:linkedin.com/in prefix", () => {
    expect(cleanQuery("site:linkedin.com/in software engineer")).toBe("software engineer");
  });

  it("strips year-of-experience qualifiers", () => {
    expect(cleanQuery("react 5 years senior dev")).toBe("react senior dev");
    expect(cleanQuery("10+ years backend")).toBe("backend");
  });

  it("strips the literal word 'location'", () => {
    expect(cleanQuery("frontend location auckland")).toBe("frontend auckland");
  });

  it("collapses whitespace and trims", () => {
    expect(cleanQuery("  react   developer  ")).toBe("react developer");
  });
});

describe("dedupeQueries", () => {
  it("dedupes case-insensitive duplicates", () => {
    expect(dedupeQueries(["React Dev", "react dev", "React DEV"])).toEqual(["React Dev"]);
  });

  it("dedupes after cleaning so 5-years and bare query collapse", () => {
    const out = dedupeQueries(["react developer", "react developer 5 years"]);
    expect(out).toEqual(["react developer"]);
  });

  it("preserves order of first occurrence", () => {
    expect(dedupeQueries(["alpha", "beta", "alpha", "gamma"])).toEqual(["alpha", "beta", "gamma"]);
  });

  it("filters out empty queries after cleaning", () => {
    expect(dedupeQueries(["", "  ", "react"])).toEqual(["react"]);
  });
});
