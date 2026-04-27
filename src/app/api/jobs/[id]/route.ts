import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized, requireJobAccess } from "@/lib/session";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;
  const { error } = await requireJobAccess(id, auth);
  if (error) return error;

  const full = await prisma.job.findUnique({
    where: { id },
    include: { candidates: { orderBy: [{ matchScore: "desc" }, { createdAt: "desc" }] } },
  });
  return NextResponse.json(full);
}

const PatchJobSchema = z.object({
  title:      z.string().min(1).max(200).trim().optional(),
  company:    z.string().max(200).trim().optional(),
  location:   z.string().max(200).trim().optional(),
  status:     z.enum(["active", "closed", "on-hold"]).optional(),
  rawJd:      z.string().min(1).max(50_000).optional(),
  parsedRole: z.string().max(100_000).optional(),
  salaryMin:  z.number().int().min(0).max(2_000_000).nullable().optional(),
  salaryMax:  z.number().int().min(0).max(2_000_000).nullable().optional(),
  orgId:      z.string().nullable().optional(), // owner-only: reassign after org delete
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;
  const { error } = await requireJobAccess(id, auth);
  if (error) return error;

  const result = PatchJobSchema.safeParse(await req.json().catch(() => ({})));
  if (!result.success) return NextResponse.json({ error: result.error.flatten() }, { status: 422 });
  const body = result.data;

  const job = await prisma.job.update({
    where: { id },
    data: {
      ...(body.title      !== undefined && { title: body.title }),
      ...(body.company    !== undefined && { company: body.company }),
      ...(body.location   !== undefined && { location: body.location }),
      ...(body.status     !== undefined && { status: body.status }),
      ...(body.rawJd      !== undefined && { rawJd: body.rawJd }),
      ...(body.parsedRole !== undefined && { parsedRole: body.parsedRole }),
      ...(body.salaryMin  !== undefined && { salaryMin: body.salaryMin }),
      ...(body.salaryMax  !== undefined && { salaryMax: body.salaryMax }),
      // orgId reassignment is owner-only (used after an org delete orphans jobs)
      ...(body.orgId !== undefined && auth.isOwner && { orgId: body.orgId }),
    },
  });
  return NextResponse.json(job);
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;
  const { error } = await requireJobAccess(id, auth);
  if (error) return error;
  await prisma.job.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
