/**
 * POST /api/admin/backup/run — take a database backup into object storage.
 *
 * Driven by the daily in-process timer (instrumentation.ts) and callable by an
 * owner on demand. Exists because the production Postgres volume was found with
 * zero snapshots and zero backup schedules (2026-07-28), and Railway's own
 * backup scheduling is gated for this account.
 *
 * Auth: cron secret (timing-safe) OR an owner session — same shape as the other
 * cron entrypoints, plus a human path so it can be triggered from the app.
 */

import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { runDatabaseBackup } from "@/lib/db-backup";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// A full export of ~183k rows takes well over the default budget.
export const maxDuration = 300;

type AnySession = { user?: { role?: string } } | null;

function timingSafe(provided: string | null, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  const cronOk = timingSafe(req.headers.get("x-cron-secret"), process.env.CONTACT_SYNC_CRON_SECRET);
  if (!cronOk) {
    const session = (await getServerSession(authOptions)) as AnySession;
    if (session?.user?.role !== "owner") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const started = Date.now();
  const result = await runDatabaseBackup();
  const ms = Date.now() - started;

  // Log either way — a backup that fails quietly is how you end up with none.
  if (result.ok) {
    console.log(`[backup] ok — ${result.rows} rows, ${Math.round((result.bytes ?? 0) / 1048576)}MB, pruned ${result.pruned}, ${ms}ms`);
  } else {
    console.error(`[backup] FAILED — ${result.error ?? result.skipped}`);
  }

  return NextResponse.json({ ...result, ms }, { status: result.ok ? 200 : 500 });
}
