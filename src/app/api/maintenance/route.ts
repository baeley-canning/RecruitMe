import { auth } from "@/auth";
import { NextResponse } from "next/server";
import { runMaintenance } from "@/lib/maintenance";

type AnySession = { user?: { role?: string } } | null;

// Called by Railway's cron or manually by the owner.
// Safe to call multiple times — all operations are idempotent.
export async function POST() {
  const session = await auth();
  if (session?.user?.role !== "owner") {
    return NextResponse.json({ error: "Owner only" }, { status: 403 });
  }
  await runMaintenance();
  return NextResponse.json({ ok: true });
}
