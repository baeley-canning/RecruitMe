import { NextResponse } from "next/server";

const baseCookieNames = [
  "next-auth.session-token",
  "__Secure-next-auth.session-token",
  "next-auth.callback-url",
  "__Secure-next-auth.callback-url",
  "next-auth.csrf-token",
  "__Host-next-auth.csrf-token",
  "next-auth.pkce.code_verifier",
  "__Secure-next-auth.pkce.code_verifier",
  "next-auth.state",
  "__Secure-next-auth.state",
  "next-auth.nonce",
  "__Secure-next-auth.nonce",
];

const chunkCookieNames = Array.from({ length: 6 }, (_, index) => [
  `next-auth.session-token.${index}`,
  `__Secure-next-auth.session-token.${index}`,
]).flat();

function expiredCookie(name: string, secure: boolean) {
  return [
    `${name}=`,
    "Path=/",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "Max-Age=0",
    "SameSite=Lax",
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

function clearSession() {
  const response = NextResponse.json({ ok: true });

  for (const name of [...baseCookieNames, ...chunkCookieNames]) {
    const requiresSecure = name.startsWith("__Secure-") || name.startsWith("__Host-");
    response.headers.append("Set-Cookie", expiredCookie(name, requiresSecure));
  }

  return response;
}

// No GET handler: clearing auth cookies on GET is a CSRF vector (an <img> tag or
// link prefetch could force a logout). The login page POSTs here.
export function POST(req: Request) {
  // CSRF defence: only same-origin callers may force a logout. Same-origin
  // requests omit Origin or match Host; a cross-site forgery carries a foreign
  // Origin. Mirrors the box-dashboard control route's same-origin check.
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) {
        return NextResponse.json({ error: "cross_origin" }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: "bad_origin" }, { status: 403 });
    }
  }
  return clearSession();
}
