import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { purgeOldUsageEvents, purgeExpiredLoginAttempts, purgeOldSearchSessions, purgeOldFetchSessions, purgeOldJobParseHistory } from "@/lib/maintenance";

type AnySession = { user?: { role?: string } } | null;

// Called by Railway's cron or manually by the owner.
// Safe to call multiple times — all operations are idempotent.
export async function POST() {
  const session = await getServerSession(authOptions) as AnySession;
  if (session?.user?.role !== "owner") {
    return NextResponse.json({ error: "Owner only" }, { status: 403 });
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
