import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// D6: the Ollama (qwen2.5:1.5b) branch in extractCandidateInfo used to accept
// the local model's JSON if ANY of name/headline/location was truthy — no
// sanity check. A 1.5B model on noisy input can hallucinate or put a company
// name in the `name` field. The guard now only accepts the local result when
// the name passes looksLikeCapturedName; a bad name falls through to Claude.

const chatMocks = vi.hoisted(() => ({
  chat: vi.fn(),
  chatWithMaybeFailover: vi.fn(),
  chatWithFailover: vi.fn(),
  ollamaProviderFor: vi.fn(),
}));

// Keep the REAL parseJson so we exercise the actual parse path; only stub chat.
vi.mock("../chat", async (importActual) => {
  const actual = await importActual<typeof import("../chat")>();
  return { ...actual, chat: chatMocks.chat };
});
vi.mock("../chat-with-failover", () => ({
  chatWithMaybeFailover: chatMocks.chatWithMaybeFailover,
  chatWithFailover: chatMocks.chatWithFailover,
}));
vi.mock("../local-routing", () => ({
  ollamaProviderFor: chatMocks.ollamaProviderFor,
}));

import { extractCandidateInfo } from "../profile";

const LONG_PROFILE =
  "Jane Doe is a senior software engineer based in Auckland with a decade of " +
  "experience building distributed systems and developer tooling.";

beforeEach(() => {
  vi.clearAllMocks();
  // Default: info_extract is routed to Ollama.
  chatMocks.ollamaProviderFor.mockReturnValue("ollama");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("extractCandidateInfo — D6 Ollama output validation", () => {
  it("falls back to Claude when Ollama returns a garbage name", async () => {
    // Ollama hallucinates a non-name in the name slot — lowercase + a CTA verb,
    // which fails looksLikeCapturedName (not Title-Case, contains no real name).
    chatMocks.chat.mockResolvedValue(
      JSON.stringify({ name: "connect to view profile", headline: "We are hiring", location: "" }),
    );
    // Claude returns the correct identity.
    chatMocks.chatWithMaybeFailover.mockResolvedValue(
      JSON.stringify({ name: "Jane Doe", headline: "Senior Software Engineer", location: "Auckland, New Zealand" }),
    );

    const result = await extractCandidateInfo(LONG_PROFILE);

    // Did NOT accept the bad Ollama name; fell through to Claude.
    expect(chatMocks.chat).toHaveBeenCalledTimes(1);
    expect(chatMocks.chatWithMaybeFailover).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      name: "Jane Doe",
      headline: "Senior Software Engineer",
      location: "Auckland, New Zealand",
    });
  });

  it("accepts a clean Ollama result without calling Claude", async () => {
    chatMocks.chat.mockResolvedValue(
      JSON.stringify({ name: "Jane Doe", headline: "Senior Engineer", location: "Auckland, New Zealand" }),
    );

    const result = await extractCandidateInfo(LONG_PROFILE);

    expect(chatMocks.chat).toHaveBeenCalledTimes(1);
    expect(chatMocks.chatWithMaybeFailover).not.toHaveBeenCalled();
    expect(result).toEqual({
      name: "Jane Doe",
      headline: "Senior Engineer",
      location: "Auckland, New Zealand",
    });
  });

  it("accepts the Ollama name but drops an implausible location", async () => {
    chatMocks.chat.mockResolvedValue(
      JSON.stringify({
        name: "Jane Doe",
        headline: "Senior Engineer",
        // Not a location — a sentence the model misassigned.
        location: "Experienced engineer who has worked across many teams and projects globally",
      }),
    );

    const result = await extractCandidateInfo(LONG_PROFILE);

    expect(chatMocks.chatWithMaybeFailover).not.toHaveBeenCalled();
    expect(result.name).toBe("Jane Doe");
    expect(result.location).toBe(""); // junk location dropped, name kept
  });

  it("uses Claude directly when info_extract is not routed to Ollama", async () => {
    chatMocks.ollamaProviderFor.mockReturnValue(undefined);
    chatMocks.chatWithMaybeFailover.mockResolvedValue(
      JSON.stringify({ name: "Jane Doe", headline: "Engineer", location: "Auckland, New Zealand" }),
    );

    const result = await extractCandidateInfo(LONG_PROFILE);

    expect(chatMocks.chat).not.toHaveBeenCalled();
    expect(chatMocks.chatWithMaybeFailover).toHaveBeenCalledTimes(1);
    expect(result.name).toBe("Jane Doe");
  });
});
