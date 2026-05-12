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

  it("returns defaults-ON failover flags when no env vars are set", () => {
    const cfg = readLocalModelConfig();
    expect(cfg.baseUrl).toBe("http://localhost:11434");
    expect(cfg.model).toBe("qwen2.5:7b");
    expect(cfg.timeoutMs).toBe(30_000);
    // Default ON: a Claude outage automatically falls over to Llama
    // without requiring env-var configuration first. Llama-derived
    // results are marked with scoredBy="ollama", the 10pt penalty, and
    // the UI provenance pill — so this is never silent.
    expect(cfg.failoverEnabled).toBe(true);
    expect(cfg.finalScoringFailoverEnabled).toBe(true);
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

  it("treats explicit truthy values as enabled (case-insensitive)", () => {
    process.env.ENABLE_LOCAL_MODEL_FAILOVER = "true";
    expect(readLocalModelConfig().failoverEnabled).toBe(true);
    process.env.ENABLE_LOCAL_MODEL_FAILOVER = "TRUE";
    expect(readLocalModelConfig().failoverEnabled).toBe(true);
    process.env.ENABLE_LOCAL_MODEL_FAILOVER = "1";
    expect(readLocalModelConfig().failoverEnabled).toBe(true);
    process.env.ENABLE_LOCAL_MODEL_FAILOVER = "yes";
    expect(readLocalModelConfig().failoverEnabled).toBe(true);
  });

  it("treats explicit false-ish values as opt-out", () => {
    process.env.ENABLE_LOCAL_MODEL_FAILOVER = "false";
    expect(readLocalModelConfig().failoverEnabled).toBe(false);
    process.env.ENABLE_LOCAL_MODEL_FAILOVER = "0";
    expect(readLocalModelConfig().failoverEnabled).toBe(false);
    process.env.ENABLE_LOCAL_MODEL_FAILOVER = "no";
    expect(readLocalModelConfig().failoverEnabled).toBe(false);
    process.env.ENABLE_LOCAL_MODEL_FAILOVER = "off";
    expect(readLocalModelConfig().failoverEnabled).toBe(false);
  });

  it("treats unrecognised non-false values as default-on (anything other than the opt-out list)", () => {
    process.env.ENABLE_LOCAL_MODEL_FAILOVER = "maybe";
    expect(readLocalModelConfig().failoverEnabled).toBe(true);
    process.env.ENABLE_LOCAL_MODEL_FAILOVER = "";
    expect(readLocalModelConfig().failoverEnabled).toBe(true);
  });

  it("final-scoring failover is independently controlled (can be turned off while keeping low-risk failover on)", () => {
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
