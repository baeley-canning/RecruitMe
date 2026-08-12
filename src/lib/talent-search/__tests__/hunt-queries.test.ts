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
import { describe, it, expect } from "vitest";
import { buildHuntQueries } from "../hunt-queries";
import type { ParsedRole } from "@/lib/ai";

const role = (over: Partial<ParsedRole> = {}): ParsedRole =>
  ({
    title: "Observability and Networks Manager",
    synonym_titles: ["Network Operations Manager", "Observability Manager", "Infrastructure Manager"],
    must_haves: ["Network leadership", "Observability platforms", "AIOps"],
    anchor_terms: ["observability", "AIOps", "network"],
    skills_required: ["Datadog", "OpenTelemetry"],
    ...over,
  }) as ParsedRole;

describe("buildHuntQueries", () => {
  it("returns several distinct angles, not one query", () => {
    const qs = buildHuntQueries(role());
    expect(qs.length).toBeGreaterThanOrEqual(3);
    expect(new Set(qs.map((q) => q.query.toLowerCase())).size).toBe(qs.length);
  });

  it("leads with the role's own title", () => {
    expect(buildHuntQueries(role())[0].query).toBe("Observability and Networks Manager");
  });

  it("includes each synonym title as its own search", () => {
    const qs = buildHuntQueries(role()).map((q) => q.query);
    expect(qs).toContain("Network Operations Manager");
    expect(qs).toContain("Observability Manager");
  });

  it("combines a title head with an anchor term, the way a recruiter would", () => {
    const qs = buildHuntQueries(role()).map((q) => q.query.toLowerCase());
    // e.g. "Infrastructure Manager AIOps" / "Networks Manager observability"
    expect(qs.some((q) => q.includes("manager") && /aiops|observability/.test(q))).toBe(true);
  });

  it("never starts a query with a connective — 'and Networks Manager AIOps' is not a search", () => {
    // "Observability and Networks Manager" naively yields the head
    // "and Networks Manager". A query opening with a stopword is noise to
    // LinkedIn and nonsense to the recruiter reading the plan.
    for (const { query } of buildHuntQueries(role())) {
      expect(query.toLowerCase()).not.toMatch(/^(and|or|of|for|the|a|an|in|to|with|&)\b/);
    }
  });

  it("every query reads like something a recruiter would actually type", () => {
    for (const { query } of buildHuntQueries(role())) {
      expect(query.trim()).toBe(query);
      expect(query).not.toMatch(/\s{2,}/);
      expect(query.length).toBeGreaterThan(2);
    }
  });

  it("emits NO quotes, parens or boolean operators — this is the plain search bar", () => {
    for (const { query } of buildHuntQueries(role())) {
      expect(query).not.toMatch(/["()]/);
      expect(query).not.toMatch(/\b(AND|OR|NOT)\b/);
    }
  });

  it("keeps each query short — two to four words is what LinkedIn rewards", () => {
    for (const { query } of buildHuntQueries(role())) {
      expect(query.split(/\s+/).length).toBeLessThanOrEqual(5);
    }
  });

  it("labels each query so the recruiter can see why it is being run", () => {
    for (const q of buildHuntQueries(role())) {
      expect(q.rationale.length).toBeGreaterThan(0);
    }
  });

  it("caps the portfolio so a hunt cannot run twenty searches at the account", () => {
    const huge = role({
      synonym_titles: Array.from({ length: 30 }, (_, i) => `Title Variant ${i}`),
      anchor_terms: Array.from({ length: 30 }, (_, i) => `anchor${i}`),
    });
    expect(buildHuntQueries(huge).length).toBeLessThanOrEqual(6);
  });

  it("still produces something usable for a role with only a title", () => {
    const bare = buildHuntQueries({ title: "Software Engineer" } as ParsedRole);
    expect(bare.length).toBeGreaterThanOrEqual(1);
    expect(bare[0].query).toBe("Software Engineer");
  });

  it("returns nothing when there is no title to search on, rather than inventing one", () => {
    expect(buildHuntQueries({ title: "" } as ParsedRole)).toEqual([]);
    expect(buildHuntQueries({} as ParsedRole)).toEqual([]);
  });

  it("drops prose requirements that would never work as a search", () => {
    const prose = role({
      anchor_terms: ["Experience with observability platforms at enterprise scale", "AIOps"],
    });
    for (const { query } of buildHuntQueries(prose)) {
      expect(query.split(/\s+/).length).toBeLessThanOrEqual(5);
      expect(query.toLowerCase()).not.toContain("experience with");
    }
  });

  it("never throws on junk", () => {
    for (const junk of [{}, { title: null }, { title: "x", synonym_titles: null }, { title: "x", anchor_terms: [null] }]) {
      expect(() => buildHuntQueries(junk as unknown as ParsedRole)).not.toThrow();
    }
  });
});
