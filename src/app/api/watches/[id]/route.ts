/**
 * PATCH  /api/watches/[id] — edit a watch (name/query/location/interval/notifyFrom/active).
 * DELETE /api/watches/[id] — delete a watch (cascades its hit ledger).
 *
 * Profile-Update Alerts (Stage C). Gated on isProfileWatchEnabled() — 404 when
 * off. Org-scoped: updateWatch/deleteWatch filter by (id, orgId), so a wrong
 * id OR another org's id both return 404 (don't leak existence).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuth, unauthorized } from "@/lib/session";
import { isProfileWatchEnabled } from "@/lib/feature-flags";
import {
  updateWatch,
  deleteWatch,
  MIN_INTERVAL_MINUTES,
  MAX_INTERVAL_MINUTES,
} from "@/lib/watched-search";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function notFound() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

const PatchSchema = z
  .object({
    name: z.string().min(1).max(120).trim().optional(),
    query: z.string().min(1).max(2000).optional(),
    location: z.string().max(200).nullable().optional(),
    intervalMinutes: z
      .number()
      .int()
      .min(MIN_INTERVAL_MINUTES)
      .max(MAX_INTERVAL_MINUTES)
      .optional(),
    notifyFrom: z.coerce.date().optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!isProfileWatchEnabled()) return notFound();
  const auth = await getAuth();
  if (!auth) return unauthorized();
  if (!auth.orgId) return notFound();

  const { id } = await ctx.params;
  const parsed = PatchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });
  }

  try {
    const watch = await updateWatch(id, auth.orgId, parsed.data);
    if (!watch) return notFound();
    return NextResponse.json({ watch });
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2002") {
      return NextResponse.json({ error: "A watch with that name already exists" }, { status: 409 });
    }
    throw err;
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!isProfileWatchEnabled()) return notFound();
  const auth = await getAuth();
  if (!auth) return unauthorized();
  if (!auth.orgId) return notFound();

  const { id } = await ctx.params;
  const ok = await deleteWatch(id, auth.orgId);
  if (!ok) return notFound();
  return NextResponse.json({ deleted: true });
}
