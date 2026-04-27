import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { extractCandidateInfo, predictAcceptance, scoreCandidateStructured } from "@/lib/ai";
import type { ParsedRole } from "@/lib/ai";
import { applyLocationFitOverride, deriveUpdateData } from "@/lib/score-utils";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";
import { buildScoreCacheKey } from "@/lib/utils";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;
  const { error } = await requireJobAccess(id, auth);
  if (error) return error;
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
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;
  const result = CreateCandidateSchema.safeParse(await req.json().catch(() => ({})));
  if (!result.success) {
    return NextResponse.json({ error: result.error.flatten() }, { status: 422 });
  }
  const body = result.data;

  const { job, error } = await requireJobAccess(id, auth);
  if (error || !job) return error;

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
      const rawBreakdown = await scoreCandidateStructured(body.profileText, parsedRole, salary);
      const breakdown = applyLocationFitOverride(
        rawBreakdown,
        location || null,
        parsedRole.location,
        parsedRole.location_rules,
        job.isRemote,
      );
      const updateData: Record<string, unknown> = {
        ...deriveUpdateData(breakdown),
        profileTextHash: buildScoreCacheKey({
          profileText: body.profileText,
          parsedRole,
          salary,
          jobLocation: job.location,
          isRemote: job.isRemote,
        }),
      };
      if (body.profileText.length >= 250) {
        const acceptance = await predictAcceptance(body.profileText, parsedRole, salary);
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
