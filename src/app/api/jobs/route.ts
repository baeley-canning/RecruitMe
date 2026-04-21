import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized, jobsWhere } from "@/lib/session";

export async function GET() {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const jobs = await prisma.job.findMany({
    where: jobsWhere(auth),
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { candidates: true } },
      candidates: { where: { status: "shortlisted" }, select: { id: true } },
    },
  });
  return NextResponse.json(jobs);
}

const CreateJobSchema = z.object({
  title:     z.string().min(1, "Title is required").max(200).trim(),
  company:   z.string().max(200).trim().optional(),
  location:  z.string().max(200).trim().optional(),
  isRemote:  z.boolean().optional(),
  rawJd:     z.string().min(10, "Job description is too short").max(50_000),
  salaryMin: z.number().int().min(0).max(2_000_000).nullable().optional(),
  salaryMax: z.number().int().min(0).max(2_000_000).nullable().optional(),
});

export async function POST(req: Request) {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const result = CreateJobSchema.safeParse(await req.json().catch(() => ({})));
  if (!result.success) {
    return NextResponse.json({ error: result.error.flatten() }, { status: 422 });
  }
  const { title, company, location, isRemote, rawJd, salaryMin, salaryMax } = result.data;

  const job = await prisma.job.create({
    data: {
      title,
      company:   company  || null,
      location:  location || null,
      isRemote:  isRemote ?? false,
      rawJd,
      salaryMin: salaryMin ?? null,
      salaryMax: salaryMax ?? null,
      orgId:     auth.orgId,
    },
  });

  return NextResponse.json(job, { status: 201 });
}
