import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

// Mock both providers at the chat() layer so neither makes a real
// network call. Tests run in CI without ANTHROPIC_API_KEY/OPENAI_API_KEY.
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
    delete process.env.OPENAI_API_KEY;
    delete process.env.AI_PROVIDER;
  });
  afterEach(() => { process.env = { ...snapshot }; });

  it("neither key set → no primary, no fallback", () => {
    expect(probeProviders()).toEqual({ hasClaude: false, hasOpenAI: false, primary: null });
  });

  it("only Claude → Claude primary, no fallback", () => {
    process.env.ANTHROPIC_API_KEY = "test";
    expect(probeProviders()).toEqual({ hasClaude: true, hasOpenAI: false, primary: "claude" });
  });

  it("only OpenAI → OpenAI primary, no fallback", () => {
    process.env.OPENAI_API_KEY = "test";
    expect(probeProviders()).toEqual({ hasClaude: false, hasOpenAI: true, primary: "openai" });
  });

  it("both keys → Claude primary, OpenAI fallback (default)", () => {
    process.env.ANTHROPIC_API_KEY = "test";
    process.env.OPENAI_API_KEY = "test";
    expect(probeProviders()).toEqual({
      hasClaude: true, hasOpenAI: true, primary: "claude", fallback: "openai",
    });
  });

  it("AI_PROVIDER=openai with both keys → OpenAI primary, Claude fallback", () => {
    process.env.ANTHROPIC_API_KEY = "test";
    process.env.OPENAI_API_KEY = "test";
    process.env.AI_PROVIDER = "openai";
    expect(probeProviders()).toEqual({
      hasClaude: true, hasOpenAI: true, primary: "openai", fallback: "claude",
    });
  });

  it("isAiFailoverConfigured() is true iff BOTH keys are set", () => {
    process.env.ANTHROPIC_API_KEY = "test";
    expect(isAiFailoverConfigured()).toBe(false);
    process.env.OPENAI_API_KEY = "test";
    expect(isAiFailoverConfigured()).toBe(true);
  });
});

describe("chatWithFailover — behaviour matrix", () => {
  const snapshot = { ...process.env };
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test";
    process.env.OPENAI_API_KEY = "test";
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

  it("primary Claude fails → falls over to OpenAI, returns openai source", async () => {
    vi.mocked(chat)
      .mockRejectedValueOnce(Object.assign(new Error("Credit balance is too low"), { status: 400 }))
      .mockResolvedValueOnce("OpenAI reply.");
    const result = await chatWithFailover("hi", 0.1, 100);
    expect(result.source).toBe("openai");
    expect(result.text).toBe("OpenAI reply.");
    expect(result.failoverReason).toMatch(/400/);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat).toHaveBeenNthCalledWith(2, "hi", 0.1, 100, expect.objectContaining({ provider: "openai" }));
  });

  it("Claude AND OpenAI both fail → re-throws the ORIGINAL Claude error", async () => {
    const claudeErr = Object.assign(new Error("Credit balance is too low"), { status: 400 });
    const openaiErr = Object.assign(new Error("OpenAI 503"), { status: 503 });
    vi.mocked(chat)
      .mockRejectedValueOnce(claudeErr)
      .mockRejectedValueOnce(openaiErr);
    await expect(chatWithFailover("hi", 0.1, 100)).rejects.toBe(claudeErr);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("only Claude configured → Claude failure throws WITHOUT attempting OpenAI", async () => {
    delete process.env.OPENAI_API_KEY;
    const claudeErr = Object.assign(new Error("Credit balance is too low"), { status: 400 });
    vi.mocked(chat).mockRejectedValueOnce(claudeErr);
    await expect(chatWithFailover("hi", 0.1, 100)).rejects.toBe(claudeErr);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("only OpenAI configured → OpenAI is primary, no Claude attempted", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    vi.mocked(chat).mockResolvedValueOnce("OpenAI reply.");
    const result = await chatWithFailover("hi", 0.1, 100);
    expect(result.source).toBe("openai");
    expect(chat).toHaveBeenCalledWith("hi", 0.1, 100, expect.objectContaining({ provider: "openai" }));
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("AI_PROVIDER=openai with both keys → OpenAI tried first, Claude as fallback", async () => {
    process.env.AI_PROVIDER = "openai";
    vi.mocked(chat).mockRejectedValueOnce(new Error("OpenAI bad")).mockResolvedValueOnce("Claude reply.");
    const result = await chatWithFailover("hi", 0.1, 100);
    expect(result.source).toBe("claude");
    expect(chat).toHaveBeenNthCalledWith(1, "hi", 0.1, 100, expect.objectContaining({ provider: "openai" }));
    expect(chat).toHaveBeenNthCalledWith(2, "hi", 0.1, 100, expect.objectContaining({ provider: "claude" }));
  });

  it("no providers configured → throws an actionable error before any call", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    await expect(chatWithFailover("hi", 0.1, 100)).rejects.toThrow(/No AI provider configured/);
    expect(chat).not.toHaveBeenCalled();
  });

  it("recordFailover updates aiFailoverHealth on a successful fallback", async () => {
    vi.mocked(chat).mockRejectedValueOnce(new Error("Claude dead")).mockResolvedValueOnce("OpenAI saves the day.");
    await chatWithFailover("hi", 0.1, 100);
    const snap = snapshotFailoverHealth();
    expect(snap.isPrimaryDead).toBe(true);
    expect(snap.failoverSource).toBe("openai");
    expect(snap.failoverCount).toBe(1);
  });

  it("recordPrimarySuccess clears the dead flag on the next successful primary call", async () => {
    vi.mocked(chat).mockRejectedValueOnce(new Error("Claude dead")).mockResolvedValueOnce("OpenAI saves.");
    await chatWithFailover("hi", 0.1, 100);
    expect(snapshotFailoverHealth().isPrimaryDead).toBe(true);
    vi.mocked(chat).mockResolvedValueOnce("Claude back!");
    await chatWithFailover("hi", 0.1, 100);
    const snap = snapshotFailoverHealth();
    expect(snap.isPrimaryDead).toBe(false);
    expect(snap.lastPrimarySuccessAt).not.toBeNull();
  });
});
