import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { classifyClaudeError, chatWithFailover } from "../chat-with-failover";

// We mock the underlying chat() AND ollamaGenerate so the test never makes a
// real network call. This is critical — these tests run in CI with no
// Claude key and no Ollama daemon.
vi.mock("../chat", () => ({ chat: vi.fn() }));
vi.mock("../../local-model/client", () => ({ ollamaGenerate: vi.fn() }));

import { chat } from "../chat";
import { ollamaGenerate } from "../../local-model/client";
import { snapshotFailoverHealth, __resetFailoverHealthForTests } from "../../ai-failover-health";

describe("classifyClaudeError — distinguishes DEAD vs transient", () => {
  it("flags 401/403 as dead (auth_invalid)", () => {
    const a = classifyClaudeError({ status: 401, message: "Invalid API key" });
    expect(a).toEqual({ dead: true, reason: "auth_invalid" });
    const b = classifyClaudeError({ status: 403, message: "Forbidden" });
    expect(b).toEqual({ dead: true, reason: "auth_invalid" });
  });

  it("flags 400 with credit-balance body as dead (credits_exhausted) — the actual prod symptom Anthropic returns", () => {
    // Real prod payload: `400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. ..."}}`
    expect(classifyClaudeError({ status: 400, message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." }))
      .toEqual({ dead: true, reason: "credits_exhausted" });
    expect(classifyClaudeError({ status: 400, message: "insufficient credits" }))
      .toEqual({ dead: true, reason: "credits_exhausted" });
    expect(classifyClaudeError({ status: 400, message: "billing issue" }))
      .toEqual({ dead: true, reason: "credits_exhausted" });
  });

  it("does NOT flag a generic 400 bad-request as dead (we don't want every validation error to burn an Ollama call)", () => {
    expect(classifyClaudeError({ status: 400, message: "max_tokens must be a positive integer" }).dead).toBe(false);
    expect(classifyClaudeError({ status: 400, message: "Invalid value for 'temperature'" }).dead).toBe(false);
  });

  it("flags 429 with credit-related body as dead (credits_exhausted)", () => {
    expect(classifyClaudeError({ status: 429, message: "Credit balance is too low to complete this request" }))
      .toEqual({ dead: true, reason: "credits_exhausted" });
    expect(classifyClaudeError({ status: 429, message: "quota exceeded for this org" }))
      .toEqual({ dead: true, reason: "credits_exhausted" });
    expect(classifyClaudeError({ status: 429, message: "insufficient credits" }))
      .toEqual({ dead: true, reason: "credits_exhausted" });
  });

  it("flags plain 429 'rate limit' as dead (rate_limited) — SDK retries already exhausted by the time we see it", () => {
    expect(classifyClaudeError({ status: 429, message: "Rate limit exceeded" }))
      .toEqual({ dead: true, reason: "rate_limited" });
    expect(classifyClaudeError({ status: 429, message: "Too many requests, retry later" }))
      .toEqual({ dead: true, reason: "rate_limited" });
  });

  it("flags persistent 5xx as dead (service_unavailable)", () => {
    expect(classifyClaudeError({ status: 502, message: "Bad Gateway" }).reason).toBe("service_unavailable");
    expect(classifyClaudeError({ status: 503, message: "Service Unavailable" }).reason).toBe("service_unavailable");
    expect(classifyClaudeError({ status: 504, message: "Gateway Timeout" }).reason).toBe("service_unavailable");
  });

  it("flags network errors (no status) as dead (network_unreachable)", () => {
    expect(classifyClaudeError(new Error("ECONNREFUSED")).reason).toBe("network_unreachable");
    expect(classifyClaudeError(new Error("getaddrinfo ENOTFOUND api.anthropic.com")).reason).toBe("network_unreachable");
    expect(classifyClaudeError(new Error("aborted")).reason).toBe("network_unreachable");
    // Anthropic SDK's APIConnectionTimeoutError + APIConnectionError surface
    // with no status code and these exact message strings — were previously
    // slipping through as not-dead.
    expect(classifyClaudeError(new Error("Request timed out.")).reason).toBe("network_unreachable");
    expect(classifyClaudeError(new Error("Connection error.")).reason).toBe("network_unreachable");
  });

  it("returns { dead: false } for unknown / non-error patterns", () => {
    expect(classifyClaudeError({ status: 400, message: "Bad request" }).dead).toBe(false);
    expect(classifyClaudeError(new Error("some other error")).dead).toBe(false);
    expect(classifyClaudeError(null).dead).toBe(false);
    expect(classifyClaudeError(undefined).dead).toBe(false);
  });
});

describe("chatWithFailover — behaviour matrix", () => {
  const snapshot = { ...process.env };
  beforeEach(() => {
    // Each test sets the flag explicitly to make the intent obvious.
    // Default-on (since 2026-05) means an undefined env var → failover IS
    // enabled; opt-out requires setting it to "false".
    delete process.env.ENABLE_LOCAL_MODEL_FAILOVER;
    delete process.env.ENABLE_LOCAL_MODEL_FINAL_SCORING;
    vi.clearAllMocks();
    __resetFailoverHealthForTests();
  });
  afterEach(() => { process.env = { ...snapshot }; });

  it("returns Claude result with source='claude' on success", async () => {
    vi.mocked(chat).mockResolvedValue("Claude said this.");
    const result = await chatWithFailover("hi", 0.1, 100);
    expect(result).toEqual({ text: "Claude said this.", source: "claude" });
    expect(ollamaGenerate).not.toHaveBeenCalled();
  });

  it("rethrows the ORIGINAL Claude error when Ollama is unreachable (only operational way to opt out of failover)", async () => {
    // Failover is hardcoded ON in code — env vars can't suppress it.
    // The only way the Claude error reaches the caller is when Ollama
    // itself is unreachable / returns null. Simulate that by making
    // ollamaGenerate resolve to null (its fail-closed contract).
    vi.mocked(chat).mockRejectedValue(Object.assign(new Error("Credit balance too low"), { status: 429 }));
    vi.mocked(ollamaGenerate).mockResolvedValue(null);
    await expect(chatWithFailover("hi", 0.1, 100)).rejects.toThrow(/credit balance/i);
    expect(ollamaGenerate).toHaveBeenCalled();
  });

  it("falls over to Ollama on a plain 429 rate-limit when failover is enabled (rate_limited reason)", async () => {
    process.env.ENABLE_LOCAL_MODEL_FAILOVER = "true";
    vi.mocked(chat).mockRejectedValue(Object.assign(new Error("Rate limit exceeded"), { status: 429 }));
    vi.mocked(ollamaGenerate).mockResolvedValue({ text: "Llama answered.", durationMs: 200 });
    const result = await chatWithFailover("hi", 0.1, 100);
    expect(result.source).toBe("ollama");
    expect(result.failoverReason).toBe("rate_limited");
  });

  it("still rethrows TRULY transient errors (non-429 4xx) even with failover enabled", async () => {
    process.env.ENABLE_LOCAL_MODEL_FAILOVER = "true";
    vi.mocked(chat).mockRejectedValue(Object.assign(new Error("Bad request"), { status: 400 }));
    await expect(chatWithFailover("hi", 0.1, 100)).rejects.toThrow(/bad request/i);
    expect(ollamaGenerate).not.toHaveBeenCalled();
  });

  it("falls over to Ollama when Claude is DEAD and failover is enabled", async () => {
    process.env.ENABLE_LOCAL_MODEL_FAILOVER = "true";
    vi.mocked(chat).mockRejectedValue(Object.assign(new Error("Credit balance is too low"), { status: 429 }));
    vi.mocked(ollamaGenerate).mockResolvedValue({ text: "Llama said this.", durationMs: 1234 });

    const result = await chatWithFailover("hi", 0.1, 100);
    expect(result.source).toBe("ollama");
    expect(result.text).toBe("Llama said this.");
    expect(result.failoverReason).toBe("credits_exhausted");
    expect(result.ollamaDurationMs).toBe(1234);
  });

  it("rethrows the ORIGINAL Claude error when Ollama also fails", async () => {
    process.env.ENABLE_LOCAL_MODEL_FAILOVER = "true";
    const claudeErr = Object.assign(new Error("ECONNREFUSED api.anthropic.com"), {});
    vi.mocked(chat).mockRejectedValue(claudeErr);
    vi.mocked(ollamaGenerate).mockResolvedValue(null); // Ollama also down

    await expect(chatWithFailover("hi", 0.1, 100)).rejects.toBe(claudeErr);
  });

  it("rethrows Claude auth error when Ollama is also unreachable", async () => {
    vi.mocked(chat).mockRejectedValue(Object.assign(new Error("Invalid API key"), { status: 401 }));
    vi.mocked(ollamaGenerate).mockResolvedValue(null);
    await expect(chatWithFailover("hi", 0.1, 100)).rejects.toThrow(/invalid api key/i);
    // Failover IS attempted (hardcoded on); it just fails because Ollama
    // returned null. Compare with the prior assertion above where Ollama
    // was wired and the test expected Llama to take over.
    expect(ollamaGenerate).toHaveBeenCalled();
  });

  it("DOES fall over on auth errors when flag IS set", async () => {
    process.env.ENABLE_LOCAL_MODEL_FAILOVER = "true";
    vi.mocked(chat).mockRejectedValue(Object.assign(new Error("Invalid API key"), { status: 401 }));
    vi.mocked(ollamaGenerate).mockResolvedValue({ text: "Llama backup.", durationMs: 100 });
    const result = await chatWithFailover("hi", 0.1, 100);
    expect(result.source).toBe("ollama");
    expect(result.failoverReason).toBe("auth_invalid");
  });

  it("updates aiFailoverHealth on Claude success (clears dead state)", async () => {
    // Seed a previous failover then confirm a Claude success clears it.
    process.env.ENABLE_LOCAL_MODEL_FAILOVER = "true";
    vi.mocked(chat).mockRejectedValueOnce(Object.assign(new Error("Credit balance is too low"), { status: 429 }));
    vi.mocked(ollamaGenerate).mockResolvedValueOnce({ text: "Llama.", durationMs: 1 });
    await chatWithFailover("hi", 0.1, 100);
    expect(snapshotFailoverHealth().isClaudeDead).toBe(true);

    vi.mocked(chat).mockResolvedValueOnce("Claude back.");
    await chatWithFailover("hi", 0.1, 100);
    const snap = snapshotFailoverHealth();
    expect(snap.isClaudeDead).toBe(false);
    expect(snap.failoverReason).toBeNull();
    expect(snap.lastClaudeSuccessAt).not.toBeNull();
    expect(snap.failoverCount).toBe(1); // counter is cumulative, not reset
  });

  it("updates aiFailoverHealth on Ollama failover (sets dead + reason + counter)", async () => {
    process.env.ENABLE_LOCAL_MODEL_FAILOVER = "true";
    vi.mocked(chat).mockRejectedValue(Object.assign(new Error("ECONNREFUSED"), {}));
    vi.mocked(ollamaGenerate).mockResolvedValue({ text: "Llama.", durationMs: 1 });
    await chatWithFailover("hi", 0.1, 100);
    await chatWithFailover("hi again", 0.1, 100);
    const snap = snapshotFailoverHealth();
    expect(snap.isClaudeDead).toBe(true);
    expect(snap.failoverReason).toBe("network_unreachable");
    expect(snap.failoverCount).toBe(2);
  });

  it("does NOT touch aiFailoverHealth when failover is disabled and Claude succeeds", async () => {
    vi.mocked(chat).mockResolvedValue("Claude OK.");
    const before = snapshotFailoverHealth();
    await chatWithFailover("hi", 0.1, 100);
    const after = snapshotFailoverHealth();
    // Success ALWAYS resets state — that's intentional. So we expect
    // lastClaudeSuccessAt to advance; everything else stays equal.
    expect(after.isClaudeDead).toBe(false);
    expect(after.failoverCount).toBe(before.failoverCount);
  });
});
