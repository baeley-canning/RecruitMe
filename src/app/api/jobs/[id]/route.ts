import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const job = await prisma.job.findUnique({
    where: { id },
    include: {
      candidates: {
        orderBy: [{ matchScore: "desc" }, { createdAt: "desc" }],
      },
    },
  });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  return NextResponse.json(job);
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
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = PatchJobSchema.safeParse(await req.json().catch(() => ({})));
  if (!result.success) {
    return NextResponse.json({ error: result.error.flatten() }, { status: 422 });
  }
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
    },
  });

  return NextResponse.json(job);
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  await prisma.job.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
