import { NextResponse } from "next/server";
import { getAuth, unauthorized } from "@/lib/session";
import { snapshotFailoverHealth } from "@/lib/ai-failover-health";
import { isAiFailoverConfigured } from "@/lib/ai/chat-with-failover";
import { snapshotProviderHealth } from "@/lib/provider-health";

export async function GET() {
  // Require auth — leaks provider + model fingerprint to anonymous callers.
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const provider = process.env.AI_PROVIDER ?? "claude";
  const failover = snapshotFailoverHealth();
  // Aggregated health for every external provider (Claude, OpenAI, SerpAPI,
  // PDL, GitHub). Drives the live green/amber/red badges on the
  // search card. Each entry's `state` is the derived UX colour — UI doesn't
  // need to re-implement the rules.
  const providers = snapshotProviderHealth();

  // Special-case: when the failover machinery has marked the primary as
  // dead, flip its badge to down regardless of stale success timestamps.
  if (failover.isPrimaryDead) {
    const primaryName = provider === "openai" ? "openai" : "claude";
    const entry = providers.find((p) => p.name === primaryName);
    if (entry) {
      entry.state = "down";
      entry.lastFailureReason = failover.failoverReason ?? entry.lastFailureReason;
    }
  }

  // Surface failover state so the banner can render a "running on
  // fallback" indicator the moment the primary fails over.
  const failoverPayload = {
    enabled: isAiFailoverConfigured(),
    isPrimaryDead: failover.isPrimaryDead,
    lastFailoverAt: failover.lastFailoverAt,
    lastPrimarySuccessAt: failover.lastPrimarySuccessAt,
    failoverReason: failover.failoverReason,
    failoverSource: failover.failoverSource,
    failoverCount: failover.failoverCount,
  };

  if (provider === "claude") {
    const hasKey = Boolean(process.env.ANTHROPIC_API_KEY?.trim());
    const model = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
    return NextResponse.json({
      available: hasKey,
      provider: "claude",
      model,
      error: hasKey ? null : "ANTHROPIC_API_KEY is not set",
      failover: failoverPayload,
      providers,
    });
  }

  if (provider === "openai") {
    const hasKey = Boolean(process.env.OPENAI_API_KEY?.trim());
    return NextResponse.json({
      available: hasKey,
      provider: "openai",
      model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      error: hasKey ? null : "OPENAI_API_KEY is not set",
      failover: failoverPayload,
      providers,
    });
  }

  return NextResponse.json({ available: false, provider, error: "Unknown AI provider", failover: failoverPayload, providers });
}
