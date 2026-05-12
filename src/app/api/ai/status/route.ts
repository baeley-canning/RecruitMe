import { NextResponse } from "next/server";
import { getAuth, unauthorized } from "@/lib/session";
import { snapshotFailoverHealth } from "@/lib/ai-failover-health";
import { isLocalFailoverEnabled } from "@/lib/local-model/config";
import { snapshotProviderHealth } from "@/lib/provider-health";

export async function GET() {
  // Require auth — leaks provider + model fingerprint to anonymous callers.
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const provider = process.env.AI_PROVIDER ?? "claude";
  const failover = snapshotFailoverHealth();
  // Aggregated health for every external provider (Claude, Ollama, SerpAPI,
  // PDL, Firmable, GitHub). Drives the live green/amber/red badges on the
  // search card. Each entry's `state` is the derived UX colour — UI doesn't
  // need to re-implement the rules.
  const providers = snapshotProviderHealth();

  // Special-case: Claude state from provider-health is just last call's
  // success/failure, but the failover module ALSO knows when Claude is
  // currently considered dead (after a verified failover). Merge so the
  // Claude badge flips red the moment the failover machinery says so,
  // even if a stale "success" timestamp is still on file.
  const claudeEntry = providers.find((p) => p.name === "claude");
  if (claudeEntry && failover.isClaudeDead) {
    claudeEntry.state = "down";
    claudeEntry.lastFailureReason = failover.failoverReason ?? claudeEntry.lastFailureReason;
  }

  // Surface failover state regardless of provider so the banner can render a
  // "running on local model" indicator the moment a Claude call fails over.
  const failoverPayload = {
    enabled: isLocalFailoverEnabled(),
    isClaudeDead: failover.isClaudeDead,
    lastFailoverAt: failover.lastFailoverAt,
    lastClaudeSuccessAt: failover.lastClaudeSuccessAt,
    failoverReason: failover.failoverReason,
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
