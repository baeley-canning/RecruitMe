/**
 * Browse the org's candidate library scoped to a specific job — returns all
 * library candidates with full profileText, EXCLUDING those already imported
 * into this job. Used by the "Browse library" modal to manually pick people
 * to add to the job (Q2.1: candidate library as first-class search target).
 *
 * The existing /api/jobs/[id]/candidates/talent-pool route does keyword-based
 * automatic matching; this is the manual-pick equivalent so the recruiter
 * can choose specific candidates.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { scoreCandidateStructured } from "@/lib/ai";
import type { ParsedRole } from "@/lib/ai";
import { applyLocationFitOverride, deriveUpdateData } from "@/lib/score-utils";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";
import { safeParseJson, buildScoreCacheKey } from "@/lib/utils";
import { getJobScoringWeights } from "@/lib/scoring-config";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;

  const { error } = await requireJobAccess(id, auth);
  if (error) return error;

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const limit = Math.min(200, Math.max(10, Number(url.searchParams.get("limit") ?? 50)));

  // URLs already imported into this job — used as a filter to exclude duplicates.
  const existing = await prisma.candidate.findMany({
    where: { jobId: id },
    select: { linkedinUrl: true },
  });
  const existingUrls = new Set(
    existing.map((c) => c.linkedinUrl?.toLowerCase()).filter(Boolean) as string[]
  );

  // Org-scoped library: anything with a profile, in this org (or anywhere if owner).
  const candidates = await prisma.candidate.findMany({
    where: {
      profileText: { not: null },
      ...(auth.isOwner ? {} : {
        OR: [
          { job: { orgId: auth.orgId } },
          { jobId: null, orgId: auth.orgId },
        ],
      }),
    },
    orderBy: { createdAt: "desc" },
    take: 500, // generous upper bound; client filters down further
    select: {
      id: true,
      name: true,
      headline: true,
      location: true,
      linkedinUrl: true,
      matchScore: true,
      createdAt: true,
      job: { select: { title: true } },
      archivedJobTitle: true,
    },
  });

  // De-duplicate by linkedinUrl — the same person across multiple jobs only
  // shows once (the most recent row wins).
  const seenUrls = new Set<string>();
  const filtered = candidates.filter((c) => {
    if (c.linkedinUrl && existingUrls.has(c.linkedinUrl.toLowerCase())) return false;
    if (c.linkedinUrl) {
      const key = c.linkedinUrl.toLowerCase();
      if (seenUrls.has(key)) return false;
      seenUrls.add(key);
    }
    if (q) {
      const hay = [c.name, c.headline, c.location].filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }).slice(0, limit);

  return NextResponse.json({ candidates: filtered, total: filtered.length });
}

const PostSchema = z.object({
  candidateIds: z.array(z.string()).min(1).max(50),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;

  const { job, error } = await requireJobAccess(id, auth);
  if (error || !job) return error;

  const parsed = PostSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });
  }

  const parsedRole = safeParseJson<ParsedRole | null>(job.parsedRole, null);
  if (!parsedRole) {
    return NextResponse.json({ error: "Analyse the job description first." }, { status: 400 });
  }

  const salary = (job.salaryMin || job.salaryMax)
    ? { min: job.salaryMin ?? 0, max: job.salaryMax ?? 0 }
    : null;
  const weights = await getJobScoringWeights(job.scoringWeights, auth.orgId);

  // Pull source candidates with full profile text — scoping to the caller's
  // org unless they're owner. Prevents importing another org's profiles.
  const sourceCandidates = await prisma.candidate.findMany({
    where: {
      id: { in: parsed.data.candidateIds },
      profileText: { not: null },
      ...(auth.isOwner ? {} : {
        OR: [
          { job: { orgId: auth.orgId } },
          { jobId: null, orgId: auth.orgId },
        ],
      }),
    },
  });

  let added = 0;
  const failed: string[] = [];

  for (const source of sourceCandidates) {
    if (!source.profileText) continue;
    try {
      const rawBreakdown = await scoreCandidateStructured(
        source.profileText,
        parsedRole,
        salary,
        weights,
        auth.orgId,
      );
      const breakdown = applyLocationFitOverride(
        rawBreakdown,
        source.location,
        parsedRole.location,
        parsedRole.location_rules,
        job.isRemote,
        weights,
      );

      await prisma.candidate.upsert({
        where: { jobId_linkedinUrl: { jobId: id, linkedinUrl: source.linkedinUrl ?? `library:${source.id}` } },
        create: {
          jobId: id,
          orgId: job.orgId ?? null,
          name: source.name,
          headline: source.headline,
          location: source.location,
          linkedinUrl: source.linkedinUrl,
          profileText: source.profileText,
          source: "talent_pool",
          status: "new",
          profileCapturedAt: source.profileCapturedAt,
          ...deriveUpdateData(breakdown),
          profileTextHash: buildScoreCacheKey({
            profileText: source.profileText,
            parsedRole,
            salary,
            jobLocation: job.location,
            isRemote: job.isRemote,
          }),
        },
        update: {
          ...deriveUpdateData(breakdown),
        },
      });
      added++;
    } catch {
      failed.push(source.id);
    }
  }

  return NextResponse.json({ added, failed });
}
