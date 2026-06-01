/**
 * Edge middleware — IP-gate sensitive routes.
 *
 * Today the only gated surface is the on-box ops dashboard
 * (/box-dashboard and /api/box-dashboard/*). It carries no recruiter
 * PII but exposes activity counts, scrape queries, and system internals
 * that we don't want reachable from the customer's office LAN.
 *
 * Allowed source IPs:
 *   - 127.0.0.1 / ::1            (loopback, the kiosk Chromium)
 *   - 100.64.0.0/10              (Tailscale's CGNAT block — seller-only)
 *
 * Anything else gets a 404 (deliberately NOT 403 — don't advertise the
 * surface exists).
 *
 * When the request lands via Caddy, the original client IP is in
 * X-Forwarded-For. Caddy sets x-real-ip + x-forwarded-for by default
 * in the reverse_proxy directive. We read the FIRST entry (untrusted-
 * facing proxy chain only has Caddy in front of Next).
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PROTECTED_PREFIXES = ["/box-dashboard", "/api/box-dashboard"];

function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function isTailscale(ip: string): boolean {
  // Tailscale's CGNAT range: 100.64.0.0/10 → 100.64.x.x through 100.127.x.x
  const m = ip.match(/^(?:::ffff:)?(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 100 && b >= 64 && b <= 127;
}

function clientIp(req: NextRequest): string {
  // Caddy puts the real client IP first in X-Forwarded-For.
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "";
}

/**
 * Correlation id for tracing one request across log lines + Sentry. Honour an
 * inbound x-request-id (so a proxy/client-supplied id chains through), else
 * mint one. Propagated on BOTH the forwarded request headers (so route handlers
 * can read it and pass it to reportError) and the response (so caller/logs can
 * correlate). crypto.randomUUID is available in the edge runtime.
 */
const REQUEST_ID_HEADER = "x-request-id";

export function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const rid = req.headers.get(REQUEST_ID_HEADER) ?? crypto.randomUUID();

  // Box-dashboard IP gate (unchanged): 404 to anything off loopback/Tailscale.
  if (PROTECTED_PREFIXES.some((p) => path === p || path.startsWith(p + "/"))) {
    const ip = clientIp(req);
    if (!isLoopback(ip) && !isTailscale(ip)) {
      // Don't advertise the surface exists to LAN-side scanners.
      return new NextResponse("Not Found", { status: 404 });
    }
  }

  // Forward the id to the route handler and echo it back to the caller.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set(REQUEST_ID_HEADER, rid);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set(REQUEST_ID_HEADER, rid);
  return res;
}

export const config = {
  // Run on all app + API routes (so every request gets a correlation id),
  // excluding Next's static/image assets and favicon to avoid pointless work.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
