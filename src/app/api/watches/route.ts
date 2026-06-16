/**
 * GET  /api/watches — list the caller's org's profile-update watches.
 * POST /api/watches — create a watch.
 *
 * Profile-Update Alerts (Stage C). Gated on isProfileWatchEnabled() — 404 when
 * off so the feature ships dark. Org-scoped: every watch belongs to the
 * caller's org; owners with no home org get a 400 (a watch needs a concrete
 * org for the SEEK scrape job + the hit ledger).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuth, unauthorized } from "@/lib/session";
import { isProfileWatchEnabled } from "@/lib/feature-flags";
import {
  createWatch,
  listWatches,
  MIN_INTERVAL_MINUTES,
  MAX_INTERVAL_MINUTES,
} from "@/lib/watched-search";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function notFound() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

const CreateSchema = z.object({
  name: z.string().min(1).max(120).trim(),
  query: z.string().min(1).max(2000),
  location: z.string().max(200).optional().nullable(),
  // Inclusive floor 30 / ceiling 1440 (issue I9). Below-floor → 422.
  intervalMinutes: z
    .number()
    .int()
    .min(MIN_INTERVAL_MINUTES)
    .max(MAX_INTERVAL_MINUTES)
    .optional(),
  // Only profile updates AT/AFTER this instant count. Defaults to "now".
  notifyFrom: z.coerce.date().optional(),
  jobId: z.string().optional().nullable(),
});

export async function GET() {
  if (!isProfileWatchEnabled()) return notFound();
  const auth = await getAuth();
  if (!auth) return unauthorized();
  if (!auth.orgId) return NextResponse.json({ watches: [] });

  const watches = await listWatches(auth.orgId);
  return NextResponse.json({ watches });
}

export async function POST(req: Request) {
  if (!isProfileWatchEnabled()) return notFound();
  const auth = await getAuth();
  if (!auth) return unauthorized();
  if (!auth.orgId) {
    return NextResponse.json({ error: "No org assigned" }, { status: 400 });
  }

  const parsed = CreateSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });
  }
  const { name, query, location, intervalMinutes, notifyFrom, jobId } = parsed.data;

  try {
    const watch = await createWatch({
      orgId: auth.orgId,
      createdBy: auth.userId,
      jobId: jobId ?? null,
      name,
      query,
      location: location ?? null,
      intervalMinutes: intervalMinutes ?? null,
      notifyFrom: notifyFrom ?? null,
    });
    return NextResponse.json({ watch }, { status: 201 });
  } catch (err) {
    // @@unique([orgId, name]) → duplicate name within the org.
    if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2002") {
      return NextResponse.json({ error: "A watch with that name already exists" }, { status: 409 });
    }
    throw err;
  }
}
