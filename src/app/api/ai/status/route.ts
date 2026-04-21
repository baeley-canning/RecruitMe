import { NextResponse } from "next/server";

export async function GET() {
  const provider = process.env.AI_PROVIDER ?? "claude";

  if (provider === "claude") {
    const hasKey = Boolean(process.env.ANTHROPIC_API_KEY?.trim());
    const model = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
    return NextResponse.json({
      available: hasKey,
      provider: "claude",
      model,
      error: hasKey ? null : "ANTHROPIC_API_KEY is not set",
    });
  }

  if (provider === "openai") {
    const hasKey = Boolean(process.env.OPENAI_API_KEY?.trim());
    return NextResponse.json({
      available: hasKey,
      provider: "openai",
      model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      error: hasKey ? null : "OPENAI_API_KEY is not set",
    });
  }

  return NextResponse.json({ available: false, provider, error: "Unknown AI provider" });
}
