import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized, requireJobAccess } from "@/lib/session";
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

  const d = result.data;

  // Verify every supplied FK belongs to the caller's org (audit L1).
  const orgScope = auth.isOwner ? {} : { orgId: auth.orgId ?? "__none__" };
  if (d.candidateId) {
    const c = await prisma.candidate.findFirst({ where: { id: d.candidateId, ...orgScope }, select: { id: true } });
    if (!c) return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
  }
  if (d.clientId) {
    const c = await prisma.client.findFirst({ where: { id: d.clientId, ...orgScope }, select: { id: true } });
    if (!c) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }
  if (d.placementId) {
    const p = await prisma.placement.findFirst({ where: { id: d.placementId, ...orgScope }, select: { id: true } });
    if (!p) return NextResponse.json({ error: "Placement not found" }, { status: 404 });
  }
  if (d.jobId) {
    const { error } = await requireJobAccess(d.jobId, auth);
    if (error) return error;
  }

  const reminder = await prisma.reminder.create({
    data: {
      orgId: auth.orgId,
      userId: auth.userId,
      ...d,
      dueAt: new Date(d.dueAt),
    },
  });
  return NextResponse.json(reminder, { status: 201 });
}
