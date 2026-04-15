import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { scoreCandidateFull, extractCandidateInfo } from "@/lib/ai";
import type { ParsedRole } from "@/lib/ai";
import { safeParseJson } from "@/lib/utils";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

const ImportSchema = z.object({
  jobId:       z.string().min(1),
  linkedinUrl: z.string().url().max(500),
  profileText: z.string().max(20_000).optional(),
});

export async function POST(req: Request) {
  const result = ImportSchema.safeParse(await req.json().catch(() => ({})));
  if (!result.success) {
    return NextResponse.json({ error: result.error.flatten() }, { status: 422, headers: CORS });
  }

  const { jobId, linkedinUrl, profileText } = result.data;

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404, headers: CORS });
  }

  const cleanUrl = linkedinUrl.split("?")[0].replace(/\/$/, "");

  let name = "Unknown";
  let headline: string | null = null;
  let location: string | null = null;

  if (profileText && profileText.length > 50) {
    try {
      const info = await extractCandidateInfo(profileText);
      if (info.name && info.name !== "Unknown" && info.name.length > 2) name = info.name;
      if (info.headline && info.headline.length > 2) headline = info.headline;
      if (info.location && info.location.length > 2) location = info.location;
    } catch { /* use defaults */ }
  }

  const existing = await prisma.candidate.findFirst({
    where: { jobId, linkedinUrl: cleanUrl },
  });

  const parsedRole = safeParseJson<ParsedRole | null>(job.parsedRole, null);
  const salary = (job.salaryMin || job.salaryMax)
    ? { min: job.salaryMin ?? 0, max: job.salaryMax ?? 0 }
    : null;

  const scoreData: Record<string, unknown> = {};

  if (profileText && profileText.length > 50 && parsedRole) {
    try {
      const { match, acceptance } = await scoreCandidateFull(profileText, parsedRole, salary);
      scoreData.matchScore  = match.score;
      scoreData.matchReason = JSON.stringify({
        summary:    match.summary,
        reasoning:  match.reasoning,
        dimensions: match.dimensions,
        strengths:  match.strengths,
        gaps:       match.gaps,
      });
      if (acceptance) {
        scoreData.acceptanceScore  = acceptance.score;
        scoreData.acceptanceReason = JSON.stringify({
          likelihood: acceptance.likelihood,
          headline:   acceptance.headline,
          signals:    acceptance.signals,
          summary:    acceptance.summary,
        });
      }
    } catch (err) {
      console.error("Bookmarklet score failed:", err);
    }
  }

  let candidate;

  if (existing) {
    candidate = await prisma.candidate.update({
      where: { id: existing.id },
      data: {
        name:        name !== "Unknown" ? name : existing.name,
        headline:    headline ?? existing.headline,
        location:    location ?? existing.location,
        profileText: profileText ?? existing.profileText,
        source:      "bookmarklet",
        ...scoreData,
      },
    });
  } else {
    candidate = await prisma.candidate.create({
      data: {
        jobId,
        name,
        headline,
        location,
        linkedinUrl: cleanUrl,
        profileText: profileText ?? null,
        source:      "bookmarklet",
        status:      "new",
        ...scoreData,
      },
    });
  }

  return NextResponse.json(
    { ...candidate, updated: Boolean(existing) },
    { status: existing ? 200 : 201, headers: CORS }
  );
}
