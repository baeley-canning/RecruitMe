/**
 * CORS headers for extension API endpoints.
 *
 * All extension endpoints require Basic auth, so the auth requirement is
 * the real guard — but a wildcard origin is still risky if a future change
 * accidentally drops auth. The static export now mirrors the per-request
 * helper (deny by default, reflect a known origin) so any drift is safer.
 */

function configuredOrigins(): Set<string> {
  const values = [
    process.env.NEXTAUTH_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : undefined,
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ];

  return new Set(
    values
      .flatMap((value) => (value ?? "").split(","))
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => {
        try {
          return new URL(value).origin;
        } catch {
          return "";
        }
      })
      .filter(Boolean)
  );
}

function configuredExtensionOrigins(): Set<string> {
  return new Set(
    (process.env.EXTENSION_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function isAllowedExtensionOrigin(origin: string): boolean {
  if (!origin) return false;
  const extensionOrigins = configuredExtensionOrigins();
  if (extensionOrigins.size > 0 && extensionOrigins.has(origin)) return true;
  if (extensionOrigins.size === 0) {
    // Unpacked Chrome/Opera/Edge extensions have installation-specific IDs, so
    // keep extension schemes working by default. Deployments that know their
    // packaged IDs can set EXTENSION_ALLOWED_ORIGINS to pin them exactly.
    if (/^chrome-extension:\/\/[a-z]{32}$/i.test(origin)) return true;
    if (/^moz-extension:\/\/[0-9a-f-]+$/i.test(origin)) return true;
    if (/^safari-extension:\/\/[a-z0-9.-]+$/i.test(origin)) return true;
  }

  return configuredOrigins().has(origin);
}

export function extensionCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allowed = !origin ? false : isAllowedExtensionOrigin(origin);

  return {
    // Reflect only allowed origins. Empty/unknown origins receive "null"
    // (denied) — credential-bearing fetches without an Origin header are
    // exotic and not part of the supported flows.
    "Access-Control-Allow-Origin": allowed ? origin : "null",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
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
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Vary": "Origin",
} as const;
