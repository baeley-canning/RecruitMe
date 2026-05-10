/**
 * CORS headers for extension API endpoints.
 *
 * All extension endpoints require Basic auth, so the auth requirement is
 * the real guard — but a wildcard origin is still risky if a future change
 * accidentally drops auth. The static export now mirrors the per-request
 * helper (deny by default, reflect a known origin) so any drift is safer.
 */

const RAILWAY_HOSTNAME_RE = /^https:\/\/(?:[a-z0-9-]+\.)?(?:railway\.app|up\.railway\.app)$/i;

function isAllowedExtensionOrigin(origin: string): boolean {
  if (!origin) return false;
  if (/^chrome-extension:\/\//i.test(origin)) return true;
  if (/^moz-extension:\/\//i.test(origin)) return true;
  if (/^safari-extension:\/\//i.test(origin)) return true;
  if (origin === (process.env.NEXTAUTH_URL ?? "")) return true;
  if (origin === "http://localhost:3000") return true;
  // Restrict railway origins to the production app domain — `endsWith`
  // matched any Railway tenant; this URL form matches only well-formed hosts.
  return RAILWAY_HOSTNAME_RE.test(origin);
}

export function extensionCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allowed = !origin ? false : isAllowedExtensionOrigin(origin);

  return {
    // Reflect only allowed origins. Empty/unknown origins receive "null"
    // (denied) — credential-bearing fetches without an Origin header are
    // exotic and not part of the supported flows.
    "Access-Control-Allow-Origin": allowed ? origin : "null",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
  };
}

/**
 * Static CORS headers used on response bodies where we don't have access to
 * the request object. Falls back to deny-by-default by emitting "null" —
 * callers that need a reflected origin should use extensionCorsHeaders(req).
 */
export const EXTENSION_CORS = {
  "Access-Control-Allow-Origin": "null",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Vary": "Origin",
} as const;
