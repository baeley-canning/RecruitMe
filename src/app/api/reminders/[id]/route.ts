import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized } from "@/lib/session";
import { isRemindersEnabled } from "@/lib/feature-flags";

// Mirror the POST contract (dueAt must be ISO, note capped at 1000) so a
// malformed body returns a clean 422 instead of a 500 (an invalid Date string
// would otherwise reach prisma.update and throw).
const PatchReminderSchema = z.object({
  dismissed: z.boolean().optional(),
  note: z.string().max(1000).nullable().optional(),
  dueAt: z.string().datetime().optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isRemindersEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const { id } = await params;
  const existing = await prisma.reminder.findFirst({
    where: { id, ...(auth.isOwner ? {} : { orgId: auth.orgId ?? "__none__" }) },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = PatchReminderSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 422 });
  }
  const body = parsed.data;
  const data: Record<string, unknown> = {};

  if (body.dismissed !== undefined) {
    data.dismissed = body.dismissed;
    data.dismissedAt = body.dismissed ? new Date() : null;
  }
  if (body.note !== undefined) data.note = body.note;
  if (body.dueAt !== undefined) data.dueAt = new Date(body.dueAt);

  const updated = await prisma.reminder.update({ where: { id }, data });
  return NextResponse.json(updated);
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isRemindersEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const { id } = await params;
  const existing = await prisma.reminder.findFirst({
    where: { id, ...(auth.isOwner ? {} : { orgId: auth.orgId ?? "__none__" }) },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.reminder.delete({ where: { id } });
  return NextResponse.json({ deleted: true });
}
