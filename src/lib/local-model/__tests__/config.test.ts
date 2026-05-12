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

  it("returns safe defaults when no env vars are set", () => {
    const cfg = readLocalModelConfig();
    expect(cfg.baseUrl).toBe("http://localhost:11434");
    expect(cfg.model).toBe("llama3.1:8b");
    expect(cfg.timeoutMs).toBe(30_000);
    expect(cfg.failoverEnabled).toBe(false);
    expect(cfg.finalScoringFailoverEnabled).toBe(false);
  });

  it("reads overrides from env", () => {
    process.env.OLLAMA_BASE_URL = "http://ollama.internal:11434";
    process.env.OLLAMA_MODEL = "llama3.2:3b";
    process.env.LOCAL_MODEL_TIMEOUT_MS = "60000";
    const cfg = readLocalModelConfig();
    expect(cfg.baseUrl).toBe("http://ollama.internal:11434");
    expect(cfg.model).toBe("llama3.2:3b");
    expect(cfg.timeoutMs).toBe(60_000);
  });

  it("accepts truthy values for the failover flag (case-insensitive)", () => {
    process.env.ENABLE_LOCAL_MODEL_FAILOVER = "true";
    expect(readLocalModelConfig().failoverEnabled).toBe(true);
    process.env.ENABLE_LOCAL_MODEL_FAILOVER = "TRUE";
    expect(readLocalModelConfig().failoverEnabled).toBe(true);
    process.env.ENABLE_LOCAL_MODEL_FAILOVER = "1";
    expect(readLocalModelConfig().failoverEnabled).toBe(true);
    process.env.ENABLE_LOCAL_MODEL_FAILOVER = "yes";
    expect(readLocalModelConfig().failoverEnabled).toBe(true);
  });

  it("treats anything else as false (safe default)", () => {
    process.env.ENABLE_LOCAL_MODEL_FAILOVER = "false";
    expect(readLocalModelConfig().failoverEnabled).toBe(false);
    process.env.ENABLE_LOCAL_MODEL_FAILOVER = "maybe";
    expect(readLocalModelConfig().failoverEnabled).toBe(false);
    process.env.ENABLE_LOCAL_MODEL_FAILOVER = "";
    expect(readLocalModelConfig().failoverEnabled).toBe(false);
  });

  it("final-scoring failover is independently controlled", () => {
    process.env.ENABLE_LOCAL_MODEL_FAILOVER = "true";
    process.env.ENABLE_LOCAL_MODEL_FINAL_SCORING = "false";
    expect(isLocalFailoverEnabled()).toBe(true);
    expect(isLocalFinalScoringFailoverEnabled()).toBe(false);
  });

  it("falls back to default timeout when LOCAL_MODEL_TIMEOUT_MS is junk", () => {
    process.env.LOCAL_MODEL_TIMEOUT_MS = "not a number";
    expect(readLocalModelConfig().timeoutMs).toBe(30_000);
  });
});
