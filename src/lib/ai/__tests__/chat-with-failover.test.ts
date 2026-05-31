import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

// Mock both providers at the chat() layer so neither makes a real
// network call. Tests run in CI without ANTHROPIC_API_KEY (Ollama is the
// always-available local fallback).
vi.mock("../chat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../chat")>();
  return { ...actual, chat: vi.fn() };
});

import { chat } from "../chat";
import {
  chatWithFailover,
  probeProviders,
  isAiFailoverConfigured,
} from "../chat-with-failover";
import { snapshotFailoverHealth, __resetFailoverHealthForTests } from "../../ai-failover-health";

describe("probeProviders — env-var detection", () => {
  const snapshot = { ...process.env };
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.AI_PROVIDER;
  });
  afterEach(() => { process.env = { ...snapshot }; });

  it("no Claude key → Ollama is the sole primary (always available, no fallback)", () => {
    expect(probeProviders()).toEqual({ hasClaude: false, hasOllama: true, primary: "ollama" });
  });

  it("Claude key set → Claude primary, Ollama fallback", () => {
    process.env.ANTHROPIC_API_KEY = "test";
    expect(probeProviders()).toEqual({
      hasClaude: true, hasOllama: true, primary: "claude", fallback: "ollama",
    });
  });

  it("isAiFailoverConfigured() is true iff Claude is configured (Ollama always available)", () => {
    expect(isAiFailoverConfigured()).toBe(false);
    process.env.ANTHROPIC_API_KEY = "test";
    expect(isAiFailoverConfigured()).toBe(true);
  });
});

describe("chatWithFailover — behaviour matrix", () => {
  const snapshot = { ...process.env };
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test";
    delete process.env.AI_PROVIDER;
    vi.clearAllMocks();
    __resetFailoverHealthForTests();
  });
  afterEach(() => { process.env = { ...snapshot }; });

  it("primary Claude succeeds → returns claude source, no fallback attempted", async () => {
    vi.mocked(chat).mockResolvedValueOnce("Claude reply.");
    const result = await chatWithFailover("hi", 0.1, 100);
    expect(result.source).toBe("claude");
    expect(result.text).toBe("Claude reply.");
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledWith("hi", 0.1, 100, expect.objectContaining({ provider: "claude" }));
  });

  it("primary Claude fails → falls over to Ollama, returns ollama source", async () => {
    vi.mocked(chat)
      .mockRejectedValueOnce(Object.assign(new Error("Credit balance is too low"), { status: 400 }))
      .mockResolvedValueOnce("Ollama reply.");
    const result = await chatWithFailover("hi", 0.1, 100);
    expect(result.source).toBe("ollama");
    expect(result.text).toBe("Ollama reply.");
    expect(result.failoverReason).toMatch(/400/);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat).toHaveBeenNthCalledWith(2, "hi", 0.1, 100, expect.objectContaining({ provider: "ollama" }));
  });

  it("Claude AND Ollama both fail → re-throws the ORIGINAL Claude error", async () => {
    const claudeErr = Object.assign(new Error("Credit balance is too low"), { status: 400 });
    const ollamaErr = Object.assign(new Error("Ollama 503"), { status: 503 });
    vi.mocked(chat)
      .mockRejectedValueOnce(claudeErr)
      .mockRejectedValueOnce(ollamaErr);
    await expect(chatWithFailover("hi", 0.1, 100)).rejects.toBe(claudeErr);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("no Claude key → Ollama is the sole primary, no Claude attempted", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    vi.mocked(chat).mockResolvedValueOnce("Ollama reply.");
    const result = await chatWithFailover("hi", 0.1, 100);
    expect(result.source).toBe("ollama");
    expect(chat).toHaveBeenCalledWith("hi", 0.1, 100, expect.objectContaining({ provider: "ollama" }));
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("no Claude key + Ollama fails → throws WITHOUT a Claude attempt (no fallback)", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const ollamaErr = Object.assign(new Error("Ollama daemon down"), { status: 503 });
    vi.mocked(chat).mockRejectedValueOnce(ollamaErr);
    await expect(chatWithFailover("hi", 0.1, 100)).rejects.toBe(ollamaErr);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("recordFailover updates aiFailoverHealth on a successful fallback", async () => {
    vi.mocked(chat).mockRejectedValueOnce(new Error("Claude dead")).mockResolvedValueOnce("Ollama saves the day.");
    await chatWithFailover("hi", 0.1, 100);
    const snap = snapshotFailoverHealth();
    expect(snap.isPrimaryDead).toBe(true);
    expect(snap.failoverSource).toBe("ollama");
    expect(snap.failoverCount).toBe(1);
  });

  it("recordPrimarySuccess clears the dead flag on the next successful primary call", async () => {
    vi.mocked(chat).mockRejectedValueOnce(new Error("Claude dead")).mockResolvedValueOnce("Ollama saves.");
    await chatWithFailover("hi", 0.1, 100);
    expect(snapshotFailoverHealth().isPrimaryDead).toBe(true);
    vi.mocked(chat).mockResolvedValueOnce("Claude back!");
    await chatWithFailover("hi", 0.1, 100);
    const snap = snapshotFailoverHealth();
    expect(snap.isPrimaryDead).toBe(false);
    expect(snap.lastPrimarySuccessAt).not.toBeNull();
  });
});
