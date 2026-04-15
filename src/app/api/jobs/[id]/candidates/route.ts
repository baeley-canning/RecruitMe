import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { scoreCandidateFull, extractCandidateInfo } from "@/lib/ai";
import type { ParsedRole } from "@/lib/ai";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const candidates = await prisma.candidate.findMany({
    where: { jobId: id },
    orderBy: [{ matchScore: "desc" }, { createdAt: "desc" }],
  });
  return NextResponse.json(candidates);
}

const CreateCandidateSchema = z.object({
  name:        z.string().min(1).max(200).trim().optional(),
  headline:    z.string().max(500).trim().optional(),
  location:    z.string().max(200).trim().optional(),
  linkedinUrl: z.string().url().max(500).optional().or(z.literal("")),
  profileText: z.string().max(50_000).optional(),
  autoScore:   z.boolean().optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = CreateCandidateSchema.safeParse(await req.json().catch(() => ({})));
  if (!result.success) {
    return NextResponse.json({ error: result.error.flatten() }, { status: 422 });
  }
  const body = result.data;

  const job = await prisma.job.findUnique({ where: { id } });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  let name = body.name ?? "";
  let headline = body.headline ?? "";
  let location = body.location ?? "";

  if (body.profileText && !name) {
    try {
      const info = await extractCandidateInfo(body.profileText);
      name = info.name;
      headline = headline || info.headline;
      location = location || info.location;
    } catch {
      name = "Unknown";
    }
  }

  const candidate = await prisma.candidate.create({
    data: {
      jobId: id,
      name: name || "Unknown",
      headline: headline || null,
      location: location || null,
      linkedinUrl: body.linkedinUrl?.trim() || null,
      profileText: body.profileText?.trim() || null,
      source: "manual",
      status: "new",
    },
  });

  if (body.autoScore !== false && body.profileText && job.parsedRole) {
    const parsedRole = JSON.parse(job.parsedRole) as ParsedRole;
    const salary = (job.salaryMin || job.salaryMax)
      ? { min: job.salaryMin ?? 0, max: job.salaryMax ?? 0 }
      : null;

    try {
      const { match, acceptance } = await scoreCandidateFull(body.profileText, parsedRole, salary);
      const updateData: Record<string, unknown> = {
        matchScore:  match.score,
        matchReason: JSON.stringify({
          summary:    match.summary,
          reasoning:  match.reasoning,
          dimensions: match.dimensions,
          strengths:  match.strengths,
          gaps:       match.gaps,
        }),
      };
      if (acceptance) {
        updateData.acceptanceScore  = acceptance.score;
        updateData.acceptanceReason = JSON.stringify({
          likelihood: acceptance.likelihood,
          headline:   acceptance.headline,
          signals:    acceptance.signals,
          summary:    acceptance.summary,
        });
      }
      const updated = await prisma.candidate.update({
        where: { id: candidate.id },
        data: updateData,
      });
      return NextResponse.json(updated, { status: 201 });
    } catch (err) {
      console.error("Auto-score failed:", err);
    }
  }

  return NextResponse.json(candidate, { status: 201 });
}
