import { describe, it, expect } from "vitest";
import OpenAI from "openai";
import { ollamaClientOptions, OLLAMA_TIMEOUT_MS } from "@/lib/ai/chat";

// Regression for review #9: the Ollama OpenAI client had no timeout, so a hung
// local inference on the 2-core box could block the request indefinitely
// (SDK default ~600s). It must carry an explicit timeout matching Claude's.
describe("ollamaClientOptions", () => {
  it("exposes a 90s timeout", () => {
    expect(OLLAMA_TIMEOUT_MS).toBe(90_000);
    expect(ollamaClientOptions().timeout).toBe(90_000);
  });

  it("produces an OpenAI client that actually carries the timeout (no network)", () => {
    const client = new OpenAI(ollamaClientOptions());
    expect(client.timeout).toBe(90_000);
  });

  it("defaults baseURL to the local Ollama endpoint", () => {
    expect(ollamaClientOptions().baseURL).toMatch(/:11434\/v1$/);
  });
});
