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

export function GET() {
  return clearSession();
}

export function POST() {
  return clearSession();
}
