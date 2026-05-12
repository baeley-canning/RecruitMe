import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { ollamaGenerate, ollamaHealthy } from "../client";

describe("ollamaGenerate — happy path", () => {
  const prev = process.env.OLLAMA_BASE_URL;
  beforeEach(() => { process.env.OLLAMA_BASE_URL = "http://localhost:11434"; });
  afterEach(() => {
    process.env.OLLAMA_BASE_URL = prev;
    vi.restoreAllMocks();
  });

  it("returns text and duration on 200 OK with a response field", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ response: "Llama said this." }), { status: 200 }),
    );
    const result = await ollamaGenerate("Say hi");
    expect(result?.text).toBe("Llama said this.");
    expect(typeof result?.durationMs).toBe("number");
  });

  it("sends model + prompt + json flag in the body when json:true is passed", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ response: "{}" }), { status: 200 }),
    );
    await ollamaGenerate("Score this profile", { json: true, model: "llama3.1:8b" });
    const body = JSON.parse(String(spy.mock.calls[0][1]?.body));
    expect(body.format).toBe("json");
    expect(body.model).toBe("llama3.1:8b");
    expect(body.prompt).toBe("Score this profile");
    expect(body.stream).toBe(false);
  });

  it("passes a system prompt through when provided", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ response: "ok" }), { status: 200 }),
    );
    await ollamaGenerate("hi", { system: "You are a recruiter." });
    const body = JSON.parse(String(spy.mock.calls[0][1]?.body));
    expect(body.system).toBe("You are a recruiter.");
  });
});

describe("ollamaGenerate — fail-closed contract", () => {
  beforeEach(() => { process.env.OLLAMA_BASE_URL = "http://localhost:11434"; });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns null on non-200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Internal", { status: 500 }));
    expect(await ollamaGenerate("x")).toBeNull();
  });

  it("returns null on network failure (fetch rejects)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await ollamaGenerate("x")).toBeNull();
  });

  it("returns null when body is non-JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>nope</html>", { status: 200 }));
    expect(await ollamaGenerate("x")).toBeNull();
  });

  it("returns null when response field is missing or empty", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    expect(await ollamaGenerate("x")).toBeNull();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ response: "" }), { status: 200 }));
    expect(await ollamaGenerate("x")).toBeNull();
  });

  it("returns null when response field is not a string", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ response: 42 }), { status: 200 }));
    expect(await ollamaGenerate("x")).toBeNull();
  });
});

describe("ollamaHealthy", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns true when /api/tags responds 200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("[]", { status: 200 }));
    expect(await ollamaHealthy()).toBe(true);
  });

  it("returns false on connection refused / network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await ollamaHealthy()).toBe(false);
  });

  it("returns false on non-200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 503 }));
    expect(await ollamaHealthy()).toBe(false);
  });
});
