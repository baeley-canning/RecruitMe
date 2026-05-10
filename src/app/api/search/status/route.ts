import { NextResponse } from "next/server";
import { getServerSetting } from "@/lib/settings";
import { getAuth, unauthorized } from "@/lib/session";

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

  const [serpapi, bing, pdl] = await Promise.all([
    getServerSetting("SERPAPI_API_KEY"),
    getServerSetting("BING_API_KEY"),
    getServerSetting("PDL_API_KEY"),
  ]);

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

  // SerpAPI and Bing keys are not tested here — making a live test request on every
  // page load would add latency and consume quota. We return "configured" (key present,
  // not verified) vs false (not configured). If a search returns 401/403, the search
  // session will be marked with "invalid key" to surface the real cause.
  return NextResponse.json({
    available: Boolean(serpapi || bing),
    sources: {
      serpapi: serpapi ? "configured" : false,
      bing:    bing    ? "configured" : false,
      pdl:     pdl     ? "configured" : false,
    },
    ai: {
      provider,
      claude: claudeStatus,
    },
  });
}
