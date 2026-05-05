/**
 * CORS headers for extension API endpoints.
 *
 * All extension endpoints require Basic auth, so these routes are not
 * vulnerable to unauthenticated CSRF even with a broad origin policy.
 * The Vary header ensures caches don't serve wrong origins.
 *
 * A proper per-request origin check (extensionCorsHeaders(req)) is provided
 * for OPTIONS preflight handlers where we have the request object; static
 * CORS is used for response bodies since the auth requirement is the real guard.
 */
export const EXTENSION_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Vary": "Origin", // required so CDN caches don't serve wrong-origin responses
} as const;

/**
 * Per-request CORS for OPTIONS preflight — returns the caller's origin
 * if it's a known extension or app origin, otherwise returns null (blocks).
 */
export function extensionCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allowed =
    !origin ||
    /^chrome-extension:\/\//i.test(origin) ||
    /^moz-extension:\/\//i.test(origin) ||
    /^safari-extension:\/\//i.test(origin) ||
    origin === (process.env.NEXTAUTH_URL ?? "") ||
    origin.endsWith(".railway.app") ||
    origin === "http://localhost:3000";

  return {
    "Access-Control-Allow-Origin": allowed ? (origin || "*") : "null",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}
