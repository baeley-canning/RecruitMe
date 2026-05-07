import { NextResponse } from "next/server";
import { getAuth, unauthorized } from "@/lib/session";
import { isScraperConfigured } from "@/lib/server-scraper";

export async function GET() {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  if (!isScraperConfigured()) {
    return NextResponse.json({ configured: false, ok: false, message: "SCRAPER_URL or SCRAPER_API_KEY not set" });
  }

  const base = process.env.SCRAPER_URL!.replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(12_000), // Railway cross-service calls can be slow
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({})) as { ok?: boolean; version?: string };
      return NextResponse.json({ configured: true, ok: true, version: data.version ?? "unknown" });
    }
    return NextResponse.json({ configured: true, ok: false, message: `Scraper returned HTTP ${res.status}` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Timeout on health check ≠ scraper is down — it may just be a slow Railway
    // cross-service call. Don't show a red banner for a health-check timeout.
    const isTimeout = msg.includes("timeout") || msg.includes("abort") || msg.includes("AbortError");
    return NextResponse.json({
      configured: true,
      ok: isTimeout ? null : false, // null = unknown (don't alarm), false = confirmed down
      message: isTimeout ? "Health check timed out — scraper may still be running" : `Scraper unreachable: ${msg}`,
    });
  }
}
