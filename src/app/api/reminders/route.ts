import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized } from "@/lib/session";
import { isRemindersEnabled } from "@/lib/feature-flags";

const CreateReminderSchema = z.object({
  candidateId: z.string().optional().nullable(),
  jobId:       z.string().optional().nullable(),
  clientId:    z.string().optional().nullable(),
  placementId: z.string().optional().nullable(),
  type:        z.enum(["follow_up", "guarantee_check", "client_feedback", "custom"]).optional(),
  dueAt:       z.string().datetime(),
  note:        z.string().max(1000).optional().nullable(),
});

export async function GET(req: Request) {
  if (!isRemindersEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const url = new URL(req.url);
  const includeDismissed = url.searchParams.get("dismissed") === "true";

  const reminders = await prisma.reminder.findMany({
    where: {
      ...(auth.isOwner ? {} : { orgId: auth.orgId ?? "__none__" }),
      ...(includeDismissed ? {} : { dismissed: false }),
    },
    orderBy: { dueAt: "asc" },
  });
  return NextResponse.json(reminders);
}

export async function POST(req: Request) {
  if (!isRemindersEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const auth = await getAuth();
  if (!auth) return unauthorized();
  if (!auth.orgId) return NextResponse.json({ error: "No org assigned" }, { status: 400 });

  const result = CreateReminderSchema.safeParse(await req.json().catch(() => ({})));
  if (!result.success) {
    return NextResponse.json({ error: result.error.flatten() }, { status: 422 });
  }

  const reminder = await prisma.reminder.create({
    data: {
      orgId: auth.orgId,
      userId: auth.userId,
      ...result.data,
      dueAt: new Date(result.data.dueAt),
    },
  });
  return NextResponse.json(reminder, { status: 201 });
}
