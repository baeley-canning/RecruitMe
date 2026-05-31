/**
 * Unit tests for src/lib/ai/insights.ts — the ProfileInsight extractor.
 *
 * All AI calls mocked. No real Claude / Ollama traffic. Tests cover:
 *  • Thin-profile fast path (no AI tokens spent)
 *  • Provider provenance flows through (Claude vs Ollama source)
 *  • Hash normalisation defeats whitespace-only changes
 *  • Hallucination guard drops evidence quotes not in source
 *  • validateAndCoerce caps array sizes + lowercases stacks/domains
 *  • Unparseable JSON throws a clear error (no silent corruption)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock for chatWithFailover — every test sets a per-call response.
const aiMocks = vi.hoisted(() => ({
  chatWithFailover: vi.fn(),
}));

vi.mock("../ai/chat-with-failover", () => aiMocks);

// Import AFTER the mock so the extractor reads from our stub.
import {
  extractInsight,
  hashProfileTextForInsight,
  buildThinProfileInsight,
  INSIGHT_MIN_PROFILE_CHARS,
  INSIGHT_EXTRACTION_VERSION,
  INSIGHT_PROMPT_VERSION,
} from "../ai/insights";

beforeEach(() => {
  aiMocks.chatWithFailover.mockReset();
});

// Helper: build a profile of N chars that's still plausibly CV-shaped so
// quotes can be located.
function longProfile(quote: string, padding = INSIGHT_MIN_PROFILE_CHARS): string {
  return [
    quote,
    "",
    "Lorem ipsum ".repeat(Math.max(1, Math.ceil(padding / 12))),
  ].join("\n");
}

describe("hashProfileTextForInsight", () => {
  it("is stable across identical inputs", () => {
    expect(hashProfileTextForInsight("Hello world")).toBe(hashProfileTextForInsight("Hello world"));
  });

  it("collapses whitespace differences (defeats nightly normaliser thrash)", () => {
    const a = "Senior\tEngineer  at  Acme";
    const b = "Senior Engineer at Acme";
    const c = "  Senior Engineer at Acme  ";
    const d = "senior engineer at acme";
    const h = hashProfileTextForInsight(a);
    expect(hashProfileTextForInsight(b)).toBe(h);
    expect(hashProfileTextForInsight(c)).toBe(h);
    expect(hashProfileTextForInsight(d)).toBe(h);
  });

  it("differs for substantively different content", () => {
    expect(hashProfileTextForInsight("Senior React Engineer"))
      .not.toBe(hashProfileTextForInsight("Senior Python Engineer"));
  });

  it("differs for non-whitespace edits even when spacing matches", () => {
    expect(hashProfileTextForInsight("Senior Engineer at Acme"))
      .not.toBe(hashProfileTextForInsight("Senior Engineer at AcmeCorp"));
  });
});

describe("buildThinProfileInsight", () => {
  it("returns a stub with thinProfile=true and no facts", () => {
    const stub = buildThinProfileInsight();
    expect(stub.thinProfile).toBe(true);
    expect(stub.currentTitle).toBeNull();
    expect(stub.primaryStack).toEqual([]);
    expect(stub.evidenceSnippets).toEqual([]);
  });
});

describe("extractInsight — thin profile fast path", () => {
  it("returns thinProfile=true and does NOT spend AI tokens for sub-threshold input", async () => {
    const profileText = "Brief CV: Jane Doe, Senior Engineer";
    expect(profileText.length).toBeLessThan(INSIGHT_MIN_PROFILE_CHARS);
    const result = await extractInsight({ profileText, orgId: "org-A" });
    expect(aiMocks.chatWithFailover).not.toHaveBeenCalled();
    expect(result.facts.thinProfile).toBe(true);
    expect(result.promptVersion).toBe(INSIGHT_PROMPT_VERSION);
    expect(result.extractionVersion).toBe(INSIGHT_EXTRACTION_VERSION);
    expect(result.sourceProfileTextHash).toBeTruthy();
    expect(result.modelId).toMatch(/deterministic-thin-profile-stub/);
  });

  it("treats empty profileText as thin (no AI call)", async () => {
    await extractInsight({ profileText: "", orgId: "org-A" });
    expect(aiMocks.chatWithFailover).not.toHaveBeenCalled();
  });
});

describe("extractInsight — AI happy path", () => {
  it("propagates extractedBy from chatWithFailover source", async () => {
    const profileText = longProfile("Senior TypeScript Engineer at Acme Corp, 8 years experience");
    aiMocks.chatWithFailover.mockResolvedValueOnce({
      text: JSON.stringify({
        currentTitle: "Senior TypeScript Engineer",
        currentEmployer: "Acme Corp",
        primaryStack: ["typescript", "node", "react"],
        secondaryStack: [],
        domains: ["saas"],
        titlesHeld: ["Senior TypeScript Engineer"],
        education: [],
        certifications: [],
        evidenceSnippets: [
          { field: "currentTitle", value: "Senior TypeScript Engineer", quote: "Senior TypeScript Engineer at Acme Corp" },
        ],
      }),
      source: "ollama",
      durationMs: 200,
    });
    const result = await extractInsight({ profileText, orgId: "org-A" });
    expect(result.extractedBy).toBe("ollama");
    expect(result.modelId).toMatch(/qwen|llama/i);
    expect(result.facts.currentTitle).toBe("Senior TypeScript Engineer");
    expect(result.facts.primaryStack).toContain("typescript");
  });

  it("defaults extractedBy to claude when source is claude", async () => {
    const profileText = longProfile("Senior Backend Engineer at Beta");
    aiMocks.chatWithFailover.mockResolvedValueOnce({
      text: JSON.stringify({
        currentTitle: "Senior Backend Engineer",
        currentEmployer: "Beta",
        primaryStack: ["go", "postgres"],
        secondaryStack: [],
        domains: [],
        titlesHeld: ["Senior Backend Engineer"],
        education: [],
        certifications: [],
        evidenceSnippets: [
          { field: "currentTitle", value: "Senior Backend Engineer", quote: "Senior Backend Engineer at Beta" },
        ],
      }),
      source: "claude",
      durationMs: 150,
    });
    const result = await extractInsight({ profileText, orgId: "org-A" });
    expect(result.extractedBy).toBe("claude");
    expect(result.modelId).toMatch(/claude/i);
  });
});

describe("extractInsight — hallucination guard", () => {
  it("drops evidence snippets whose quote is NOT in the source text", async () => {
    const profileText = longProfile("Senior Backend Engineer at Acme");
    aiMocks.chatWithFailover.mockResolvedValueOnce({
      text: JSON.stringify({
        currentTitle: "Senior Backend Engineer",
        currentEmployer: "Acme",
        primaryStack: ["go"],
        secondaryStack: [],
        domains: [],
        titlesHeld: [],
        education: [],
        certifications: [],
        evidenceSnippets: [
          { field: "currentTitle", value: "Senior Backend Engineer", quote: "Senior Backend Engineer" },
          // Fabricated quote — not present in source.
          { field: "primaryStack", value: "go", quote: "10 years of pure Go production experience" },
        ],
      }),
      source: "claude",
      durationMs: 100,
    });
    const result = await extractInsight({ profileText, orgId: "org-A" });
    expect(result.facts.evidenceSnippets).toHaveLength(1);
    expect(result.facts.evidenceSnippets[0].quote).toMatch(/Senior Backend Engineer/);
  });

  it("caps evidence quote length", async () => {
    const longQuote = "X".repeat(500);
    const profileText = longProfile(longQuote);
    aiMocks.chatWithFailover.mockResolvedValueOnce({
      text: JSON.stringify({
        currentTitle: null,
        currentEmployer: null,
        primaryStack: [],
        secondaryStack: [],
        domains: [],
        titlesHeld: [],
        education: [],
        certifications: [],
        evidenceSnippets: [{ field: "primaryStack", value: "x", quote: longQuote }],
      }),
      source: "claude",
      durationMs: 100,
    });
    const result = await extractInsight({ profileText, orgId: "org-A" });
    expect(result.facts.evidenceSnippets[0].quote.length).toBeLessThanOrEqual(241); // 240 chars + ellipsis
  });
});

describe("extractInsight — validation + coercion", () => {
  it("lowercases primaryStack and dedupes", async () => {
    const profileText = longProfile("Senior TypeScript Engineer");
    aiMocks.chatWithFailover.mockResolvedValueOnce({
      text: JSON.stringify({
        currentTitle: null,
        currentEmployer: null,
        primaryStack: ["TypeScript", "TYPESCRIPT", "React", "react"],
        secondaryStack: [],
        domains: [],
        titlesHeld: [],
        education: [],
        certifications: [],
        evidenceSnippets: [],
      }),
      source: "claude",
      durationMs: 100,
    });
    const result = await extractInsight({ profileText, orgId: "org-A" });
    expect(result.facts.primaryStack).toEqual(["typescript", "react"]);
  });

  it("caps primaryStack to 8 entries, secondaryStack to 5, domains to 8", async () => {
    const profileText = longProfile("Lots of skills");
    aiMocks.chatWithFailover.mockResolvedValueOnce({
      text: JSON.stringify({
        currentTitle: null,
        currentEmployer: null,
        primaryStack: Array.from({ length: 20 }, (_, i) => `lang-${i}`),
        secondaryStack: Array.from({ length: 20 }, (_, i) => `sec-${i}`),
        domains: Array.from({ length: 20 }, (_, i) => `dom-${i}`),
        titlesHeld: [],
        education: [],
        certifications: [],
        evidenceSnippets: [],
      }),
      source: "claude",
      durationMs: 100,
    });
    const result = await extractInsight({ profileText, orgId: "org-A" });
    expect(result.facts.primaryStack.length).toBeLessThanOrEqual(8);
    expect(result.facts.secondaryStack.length).toBeLessThanOrEqual(5);
    expect(result.facts.domains.length).toBeLessThanOrEqual(8);
  });

  it("preserves title case for titlesHeld (titles are display strings, not normalised keys)", async () => {
    const profileText = longProfile("Senior Engineer at Beta Co");
    aiMocks.chatWithFailover.mockResolvedValueOnce({
      text: JSON.stringify({
        currentTitle: null,
        currentEmployer: null,
        primaryStack: [],
        secondaryStack: [],
        domains: [],
        titlesHeld: ["Senior Engineer", "Engineering Manager"],
        education: [],
        certifications: [],
        evidenceSnippets: [],
      }),
      source: "claude",
      durationMs: 100,
    });
    const result = await extractInsight({ profileText, orgId: "org-A" });
    expect(result.facts.titlesHeld).toEqual(["Senior Engineer", "Engineering Manager"]);
  });

  it("coerces malformed education entries — drops ones without institution", async () => {
    const profileText = longProfile("Some education");
    aiMocks.chatWithFailover.mockResolvedValueOnce({
      text: JSON.stringify({
        currentTitle: null,
        currentEmployer: null,
        primaryStack: [],
        secondaryStack: [],
        domains: [],
        titlesHeld: [],
        education: [
          { institution: "Univ of Auckland", degree: "BSc CS", graduationYear: 2015 },
          { degree: "Master of Things" }, // no institution → dropped
          { institution: "" }, // empty institution → dropped
        ],
        certifications: [],
        evidenceSnippets: [],
      }),
      source: "claude",
      durationMs: 100,
    });
    const result = await extractInsight({ profileText, orgId: "org-A" });
    expect(result.facts.education).toHaveLength(1);
    expect(result.facts.education[0].institution).toBe("Univ of Auckland");
    expect(result.facts.education[0].graduationYear).toBe(2015);
  });
});

describe("extractInsight — error handling", () => {
  it("throws a clear error when the AI returns unparseable JSON", async () => {
    const profileText = longProfile("Anything goes");
    aiMocks.chatWithFailover.mockResolvedValueOnce({
      text: "{not even close to JSON",
      source: "claude",
      durationMs: 50,
    });
    await expect(extractInsight({ profileText, orgId: "org-A" })).rejects.toThrow(/unparseable JSON/);
  });

  it("propagates underlying chatWithFailover errors through withRetry exhaustion", async () => {
    const profileText = longProfile("CV body");
    // Simulate exhaustion of withRetry — fail every attempt.
    aiMocks.chatWithFailover.mockRejectedValue(new Error("upstream 503"));
    await expect(extractInsight({ profileText, orgId: "org-A" })).rejects.toThrow(/upstream 503/);
  }, 30_000); // withRetry waits with exponential backoff; allow up to 30s wall-time.
});
