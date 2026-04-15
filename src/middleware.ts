import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  if (request.method === "OPTIONS") {
    return NextResponse.next();
  }

  const user = process.env.ADMIN_USER;
  const pass = process.env.ADMIN_PASS;

  // If no credentials are configured, skip auth (local dev without credentials set)
  if (!user || !pass) return NextResponse.next();

  const authHeader = request.headers.get("authorization") ?? "";
  const expected = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

  if (authHeader !== expected) {
    return new NextResponse("Unauthorised", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="RecruitMe"' },
    });
  }

  return NextResponse.next();
}

export const config = {
  // Apply to all routes except Next.js internals and static files
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
