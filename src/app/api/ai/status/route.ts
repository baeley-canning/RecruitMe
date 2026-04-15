import { NextResponse } from "next/server";

export async function GET() {
  const provider = process.env.AI_PROVIDER ?? "ollama";

  if (provider === "openai") {
    const hasKey = Boolean(process.env.OPENAI_API_KEY?.trim());
    return NextResponse.json({
      available: hasKey,
      provider: "openai",
      model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      error: hasKey ? null : "OPENAI_API_KEY is not set in .env.local",
    });
  }

  // Ollama — try the configured URL, then common alternatives for WSL2
  const configuredBase = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
  const candidates = [
    configuredBase,
    "http://127.0.0.1:11434",
    "http://localhost:11434",
    "http://10.255.255.254:11434", // Windows host from WSL2
  ];

  // Deduplicate
  const urls = [...new Set(candidates)];

  // Race all checks in parallel — fastest response wins
  const checks = urls.map(async (base) => {
    const res = await fetch(`${base}/api/tags`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) throw new Error("not ok");
    return base;
  });

  try {
    const base = await Promise.any(checks);
    return NextResponse.json({
      available: true,
      provider: "ollama",
      model: process.env.OLLAMA_MODEL ?? "llama3.2:3b",
      base,
    });
  } catch {
    // all failed — fall through
  }

  return NextResponse.json({
    available: false,
    provider: "ollama",
    model: process.env.OLLAMA_MODEL ?? "llama3.2:3b",
    error: "Cannot connect to Ollama. Make sure Ollama is running.",
    tried: urls,
  });
}
