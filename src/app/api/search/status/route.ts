import { NextResponse } from "next/server";
import { getServerSetting } from "@/lib/settings";

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

export async function GET() {
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
    claudeStatus = key ? await checkClaudeKey(key) : "unconfigured";
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
