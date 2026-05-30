import { NextResponse } from "next/server";
import { getServerSetting } from "@/lib/settings";
import { getAuth, unauthorized } from "@/lib/session";
import { isScraperDiscoveryEnabled } from "@/lib/feature-flags";

async function checkClaudeKey(apiKey: string): Promise<"ok" | "invalid" | "error"> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key":         apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok)           return "ok";
    if (res.status === 401) return "invalid";
    return "error";
  } catch {
    return "error";
  }
}

// Cache the live Anthropic probe so an authed user spamming this route can't
// fan out to the upstream API. 60s is plenty for a config-status indicator.
let cachedClaudeStatus: { value: "ok" | "invalid" | "error" | "unconfigured"; expiresAt: number } | null = null;
const CLAUDE_PROBE_TTL_MS = 60_000;

export async function GET() {
  // Require auth — this endpoint discloses which third-party keys are
  // configured (an attacker fingerprinting the stack) and triggers a live
  // call to Anthropic per request. Both should be gated.
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const pdl = await getServerSetting("PDL_API_KEY");

  // AI provider status
  const provider = process.env.AI_PROVIDER ?? "claude";
  let claudeStatus: "ok" | "invalid" | "error" | "unconfigured" = "unconfigured";

  if (provider === "claude") {
    const key = process.env.ANTHROPIC_API_KEY?.trim();
    if (!key) {
      claudeStatus = "unconfigured";
    } else if (cachedClaudeStatus && cachedClaudeStatus.expiresAt > Date.now()) {
      claudeStatus = cachedClaudeStatus.value;
    } else {
      claudeStatus = await checkClaudeKey(key);
      cachedClaudeStatus = { value: claudeStatus, expiresAt: Date.now() + CLAUDE_PROBE_TTL_MS };
    }
  }

  // SerpAPI removed (Phase K). Search availability = PDL configured OR the
  // local scraper enabled (LinkedIn/SEEK discovery via the durable /search
  // pipeline). PDL key presence isn't live-tested to avoid quota burn.
  const scraper = isScraperDiscoveryEnabled();
  return NextResponse.json({
    available: Boolean(pdl) || scraper,
    sources: {
      pdl:     pdl ? "configured" : false,
      scraper: scraper ? "enabled" : false,
    },
    ai: {
      provider,
      claude: claudeStatus,
    },
  });
}
