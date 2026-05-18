import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { timingSafeEqual } from "node:crypto";
import { authOptions } from "@/lib/auth";
import { purgeOldUsageEvents, purgeExpiredLoginAttempts, purgeOldSearchSessions, purgeOldFetchSessions, purgeOldJobParseHistory } from "@/lib/maintenance";

type AnySession = { user?: { role?: string } } | null;

function secretsMatch(provided: string | null | undefined, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Called by Railway's cron or manually by the owner.
// Safe to call multiple times — all operations are idempotent.
export async function POST(req: Request) {
  const cronAuth = secretsMatch(req.headers.get("x-cron-secret"), process.env.MAINTENANCE_CRON_SECRET);

  if (!cronAuth) {
    const session = await getServerSession(authOptions) as AnySession;
    if (session?.user?.role !== "owner") {
      return NextResponse.json({ error: "Owner only" }, { status: 403 });
    }
  }

  const [usage, attempts, searchSessions, fetchSessions, parseHistory] = await Promise.all([
    purgeOldUsageEvents(),
    purgeExpiredLoginAttempts(),
    purgeOldSearchSessions(),
    purgeOldFetchSessions(),
    purgeOldJobParseHistory(),
  ]);
  return NextResponse.json({
    ok: true,
    deleted: {
      usage:          usage.deleted,
      attempts:       attempts.deleted,
      searchSessions: searchSessions.deleted,
      fetchSessions:  fetchSessions.deleted,
      parseHistory:   parseHistory.deleted,
    },
  });
}
