import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { readLocalModelConfig, isLocalFailoverEnabled, isLocalFinalScoringFailoverEnabled } from "../config";

describe("readLocalModelConfig", () => {
  const snapshot = { ...process.env };
  beforeEach(() => {
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.OLLAMA_MODEL;
    delete process.env.LOCAL_MODEL_TIMEOUT_MS;
    delete process.env.ENABLE_LOCAL_MODEL_FAILOVER;
    delete process.env.ENABLE_LOCAL_MODEL_FINAL_SCORING;
  });
  afterEach(() => {
    process.env = { ...snapshot };
  });

  it("returns Ollama defaults when no env vars are set", () => {
    const cfg = readLocalModelConfig();
    expect(cfg.baseUrl).toBe("http://localhost:11434");
    expect(cfg.model).toBe("qwen2.5:7b");
    expect(cfg.timeoutMs).toBe(30_000);
  });

  it("reads URL / model / timeout overrides from env", () => {
    process.env.OLLAMA_BASE_URL = "http://ollama.internal:11434";
    process.env.OLLAMA_MODEL = "llama3.2:3b";
    process.env.LOCAL_MODEL_TIMEOUT_MS = "60000";
    const cfg = readLocalModelConfig();
    expect(cfg.baseUrl).toBe("http://ollama.internal:11434");
    expect(cfg.model).toBe("llama3.2:3b");
    expect(cfg.timeoutMs).toBe(60_000);
  });

  it("falls back to default timeout when LOCAL_MODEL_TIMEOUT_MS is junk", () => {
    process.env.LOCAL_MODEL_TIMEOUT_MS = "not a number";
    expect(readLocalModelConfig().timeoutMs).toBe(30_000);
  });

  // Failover gates: hardcoded ON since the env-var dependency was a
  // production footgun. See file header in ../config.ts for rationale.
  it("failover flags are unconditionally ON regardless of env-var value", () => {
    expect(isLocalFailoverEnabled()).toBe(true);
    expect(isLocalFinalScoringFailoverEnabled()).toBe(true);
    expect(readLocalModelConfig().failoverEnabled).toBe(true);
    expect(readLocalModelConfig().finalScoringFailoverEnabled).toBe(true);
  });

  it("a stale ENABLE_LOCAL_MODEL_FAILOVER=false env var does NOT suppress failover (this used to silently kill Llama failover)", () => {
    process.env.ENABLE_LOCAL_MODEL_FAILOVER = "false";
    process.env.ENABLE_LOCAL_MODEL_FINAL_SCORING = "false";
    expect(isLocalFailoverEnabled()).toBe(true);
    expect(isLocalFinalScoringFailoverEnabled()).toBe(true);
  });
});
