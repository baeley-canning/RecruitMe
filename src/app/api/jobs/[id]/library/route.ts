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
import { getJobTargetLocation } from "@/lib/job-target-location";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";
import { safeParseJson, buildScoreCacheKey } from "@/lib/utils";
import { getJobScoringWeights } from "@/lib/scoring-config";
import { getAccessibleOrgIds, candidateOrgFilter } from "@/lib/org-access";
import { shouldRejectAsOverseas } from "@/lib/location";

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

  // Library scope: caller's own org plus any orgs the caller has been granted
  // library_read access to (cross-org subscription). Owner sees all.
  const accessibleOrgIds = await getAccessibleOrgIds(auth);
  const candidates = await prisma.candidate.findMany({
    where: {
      profileText: { not: null },
      ...candidateOrgFilter(accessibleOrgIds),
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

  // Pull source candidates with full profile text — same library scope as
  // GET (own org + granted-access orgs). Owner bypasses.
  const accessibleOrgIds = await getAccessibleOrgIds(auth);
  const sourceCandidates = await prisma.candidate.findMany({
    where: {
      id: { in: parsed.data.candidateIds },
      profileText: { not: null },
      ...candidateOrgFilter(accessibleOrgIds),
    },
  });

  let added = 0;
  const failed: string[] = [];
  const unscoredIds: string[] = []; // imported but scoring failed after retry
  const skippedOverseas: string[] = [];

  for (const source of sourceCandidates) {
    if (!source.profileText) continue;
    // Country gate: never import a confirmed-overseas candidate onto a
    // non-remote NZ role. shouldRejectAsOverseas combines explicit-location
    // check with profile-text inference (Present-role location, "based in"
    // phrases, definitely-overseas current employer, +64/+61 phone codes)
    // and applies a two-signal requirement so returnee Kiwis whose profile
    // mentions e.g. London past roles aren't false-positively rejected.
    const overseas = shouldRejectAsOverseas({
      explicitLocation: source.location,
      headline: source.headline,
      profileText: source.profileText,
      isRemote: job.isRemote,
    });
    if (overseas.reject) {
      skippedOverseas.push(source.id);
      continue;
    }

    // Try scoring twice — transient API failures (timeouts, 503s) are common
    // and a single retry catches most of them without significant latency.
    let breakdown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await scoreCandidateStructured(source.profileText, parsedRole, salary, weights, auth.orgId);
        breakdown = applyLocationFitOverride(raw, source.location, getJobTargetLocation(job, parsedRole), parsedRole.location_rules, job.isRemote, weights);
        break;
      } catch {
        if (attempt === 0) await new Promise((r) => setTimeout(r, 800));
      }
    }

    try {
      // For library candidates with no real LinkedIn URL, synthesise a stable
      // key from source.id and store it as the linkedinUrl too — otherwise
      // re-importing the same source-row produces a duplicate, because the
      // unique constraint sees `library:src-1` in the where but `null` in the
      // create row, so the upsert never finds a match.
      const linkedinUrl = source.linkedinUrl ?? `library:${source.id}`;
      await prisma.candidate.upsert({
        where: { jobId_linkedinUrl: { jobId: id, linkedinUrl } },
        create: {
          jobId: id,
          orgId: job.orgId ?? null,
          name: source.name,
          headline: source.headline,
          location: source.location,
          linkedinUrl,
          profileText: source.profileText,
          source: "talent_pool",
          status: "new",
          profileCapturedAt: source.profileCapturedAt,
          // If scoring succeeded, spread score data + hash; otherwise import
          // without a score so the candidate is visible and can be re-scored.
          ...(breakdown ? deriveUpdateData(breakdown) : {}),
          ...(breakdown ? {
            profileTextHash: buildScoreCacheKey({ profileText: source.profileText, parsedRole, salary, jobLocation: job.location, jobLocation2: job.location2, isRemote: job.isRemote, weights }),
          } : {}),
        },
        update: {
          ...(breakdown ? deriveUpdateData(breakdown) : {}),
        },
      });
      added++;
      if (!breakdown) unscoredIds.push(source.id);
    } catch {
      failed.push(source.id);
    }
  }

  return NextResponse.json({
    added,
    failed,
    // Let the UI warn the recruiter when candidates imported without scores.
    unscoredIds: unscoredIds.length > 0 ? unscoredIds : undefined,
    skippedOverseas: skippedOverseas.length > 0 ? skippedOverseas : undefined,
  });
}
