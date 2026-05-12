import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { readSearchProvidersConfig } from "../config";

describe("readSearchProvidersConfig", () => {
  const prev = {
    SEARCH_PROVIDERS: process.env.SEARCH_PROVIDERS,
    SEARXNG_BASE_URL: process.env.SEARXNG_BASE_URL,
    OPENSERP_BASE_URL: process.env.OPENSERP_BASE_URL,
    SEARCH_PROVIDER_TIMEOUT_MS: process.env.SEARCH_PROVIDER_TIMEOUT_MS,
  };

  beforeEach(() => {
    delete process.env.SEARCH_PROVIDERS;
    delete process.env.SEARXNG_BASE_URL;
    delete process.env.OPENSERP_BASE_URL;
    delete process.env.SEARCH_PROVIDER_TIMEOUT_MS;
  });

  afterEach(() => {
    process.env.SEARCH_PROVIDERS = prev.SEARCH_PROVIDERS;
    process.env.SEARXNG_BASE_URL = prev.SEARXNG_BASE_URL;
    process.env.OPENSERP_BASE_URL = prev.OPENSERP_BASE_URL;
    process.env.SEARCH_PROVIDER_TIMEOUT_MS = prev.SEARCH_PROVIDER_TIMEOUT_MS;
  });

  it("returns empty enabled list by default — route falls back to existing behaviour", () => {
    const cfg = readSearchProvidersConfig();
    expect(cfg.enabled).toEqual([]);
    expect(cfg.searxngBaseUrl).toBeNull();
    expect(cfg.openserpBaseUrl).toBeNull();
    expect(cfg.providerTimeoutMs).toBe(8000);
  });

  it("parses comma-separated SEARCH_PROVIDERS", () => {
    process.env.SEARCH_PROVIDERS = "searxng, openserp";
    expect(readSearchProvidersConfig().enabled).toEqual(["searxng", "openserp"]);
  });

  it("normalises case + trims whitespace + ignores invalid values", () => {
    process.env.SEARCH_PROVIDERS = " SearxNG , unknown_provider , openserp ";
    expect(readSearchProvidersConfig().enabled).toEqual(["searxng", "openserp"]);
  });

  it("reads base URLs and timeout override", () => {
    process.env.SEARXNG_BASE_URL = "http://localhost:8080";
    process.env.OPENSERP_BASE_URL = "http://localhost:7000";
    process.env.SEARCH_PROVIDER_TIMEOUT_MS = "12000";
    const cfg = readSearchProvidersConfig();
    expect(cfg.searxngBaseUrl).toBe("http://localhost:8080");
    expect(cfg.openserpBaseUrl).toBe("http://localhost:7000");
    expect(cfg.providerTimeoutMs).toBe(12000);
  });

  it("falls back to default timeout when SEARCH_PROVIDER_TIMEOUT_MS is junk", () => {
    process.env.SEARCH_PROVIDER_TIMEOUT_MS = "not-a-number";
    expect(readSearchProvidersConfig().providerTimeoutMs).toBe(8000);
  });
});
