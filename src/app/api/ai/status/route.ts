import { NextResponse } from "next/server";
import { getAuth, unauthorized } from "@/lib/session";
import { snapshotFailoverHealth } from "@/lib/ai-failover-health";
import { isAiFailoverConfigured } from "@/lib/ai/chat-with-failover";
import { snapshotProviderHealth } from "@/lib/provider-health";

export async function GET() {
  // Require auth — leaks provider + model fingerprint to anonymous callers.
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const failover = snapshotFailoverHealth();
  // Aggregated health for every model/enrichment provider (Claude, Ollama,
  // PDL). Drives the live green/amber/red badges on the search card. Each
  // entry's `state` is the derived UX colour — UI doesn't need to
  // re-implement the rules.
  const providers = snapshotProviderHealth();

  // Special-case: when the failover machinery has marked the primary as
  // dead, flip its badge to down regardless of stale success timestamps.
  // Claude is always the primary now (Ollama is the fallback).
  if (failover.isPrimaryDead) {
    const entry = providers.find((p) => p.name === "claude");
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

  // Claude is the primary provider; the local Ollama model is the fallback
  // (always available, surfaced via the `failover` payload + provider badges).
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
