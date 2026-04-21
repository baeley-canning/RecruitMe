import { afterEach, describe, expect, it } from "vitest";
import { getJobParsingProvider } from "@/lib/ai";

const ORIGINAL_ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

describe("getJobParsingProvider", () => {
  afterEach(() => {
    if (ORIGINAL_ANTHROPIC_KEY === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = ORIGINAL_ANTHROPIC_KEY;
    }
  });

  it("prefers Claude when an Anthropic key is configured", () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    expect(getJobParsingProvider()).toBe("claude");
  });

  it("falls back to the default provider selection when no Anthropic key exists", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(getJobParsingProvider()).toBeUndefined();
  });
});
