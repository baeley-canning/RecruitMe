import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized } from "@/lib/session";

const PatchSchema = z.object({
  status:        z.enum(["sent", "viewed", "interested", "rejected", "on_hold"]).optional(),
  clientFeedback: z.string().max(2000).nullable().optional(),
  notes:         z.string().max(2000).nullable().optional(),
  feedbackAt:    z.string().datetime().nullable().optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const { id } = await params;
  const existing = await prisma.submission.findFirst({
    where: { id, ...(auth.isOwner ? {} : { orgId: auth.orgId ?? "__none__" }) },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const result = PatchSchema.safeParse(await req.json().catch(() => ({})));
  if (!result.success) {
    return NextResponse.json({ error: result.error.flatten() }, { status: 422 });
  }

  const data: Record<string, unknown> = { ...result.data };
  if (result.data.feedbackAt) data.feedbackAt = new Date(result.data.feedbackAt);

  const updated = await prisma.submission.update({ where: { id }, data });
  return NextResponse.json(updated);
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const { id } = await params;
  const existing = await prisma.submission.findFirst({
    where: { id, ...(auth.isOwner ? {} : { orgId: auth.orgId ?? "__none__" }) },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.submission.delete({ where: { id } });
  return NextResponse.json({ deleted: true });
}
