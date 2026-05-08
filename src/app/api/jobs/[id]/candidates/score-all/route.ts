import { prisma } from "@/lib/db";
import { scoreCandidateStructured, predictAcceptance, withRetry } from "@/lib/ai";
import type { ParsedRole } from "@/lib/ai";
import { applyLocationFitOverride, deriveUpdateData } from "@/lib/score-utils";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";
import { buildScoreCacheKey, safeParseJson } from "@/lib/utils";
import { checkRateLimit, recordUsage } from "@/lib/usage";
import { getJobScoringWeights } from "@/lib/scoring-config";
import { getRecruitingContext } from "@/lib/recruiter-memory";
import { reportError } from "@/lib/error-reporting";
import { NextResponse } from "next/server";

// Allow up to 5 minutes for large scoring runs. Without this, Vercel (and some
// Railway proxy configurations) cut the connection at ~30s leaving partial results.
export const maxDuration = 300;

const CONCURRENCY = 3;

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;

  const { job, error } = await requireJobAccess(id, auth);
  if (error || !job) return error;
  if (!job.parsedRole) {
    return NextResponse.json({ error: "Parse the job description first." }, { status: 400 });
  }

  const rateCheck = await checkRateLimit(auth.orgId, "score_all");
  if (!rateCheck.allowed) {
    const waitMin = Math.ceil((rateCheck.retryAfterMs ?? 60000) / 60000);
    return NextResponse.json({ error: `Score-all rate limit reached. Try again in ~${waitMin} minute${waitMin !== 1 ? "s" : ""}.` }, { status: 429 });
  }

  await prisma.job.update({ where: { id }, data: { lastScoredAt: new Date() } });

  const candidates = await prisma.candidate.findMany({
    where: { jobId: id, profileText: { not: null } },
  });

  if (candidates.length === 0) {
    return NextResponse.json({ scored: 0, total: 0 });
  }

  const parsedRole = safeParseJson<ParsedRole | null>(job.parsedRole, null);
  if (!parsedRole) {
    return NextResponse.json({ error: "Job parse data is invalid. Parse the job description again." }, { status: 400 });
  }
  const salary = (job.salaryMin || job.salaryMax)
    ? { min: job.salaryMin ?? 0, max: job.salaryMax ?? 0 }
    : null;
  const weights = await getJobScoringWeights(job.scoringWeights, auth.orgId);

  // Pre-fetch recruiter memory once per job — avoids one DB query per candidate.
  const recruiterContext = await getRecruitingContext(parsedRole, auth.orgId).catch(() => "");

  const total = candidates.length;
  let scored = 0;
  const failed: string[] = [];
  const encoder = new TextEncoder();

  // Stream progress as newline-delimited JSON so the client can show a live counter.
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) =>
        controller.enqueue(encoder.encode(JSON.stringify(data) + "\n"));

      // Send total upfront so the client can show "0 of N" immediately.
      send({ scored: 0, total });

      for (let i = 0; i < candidates.length; i += CONCURRENCY) {
        const chunk = candidates.slice(i, i + CONCURRENCY);
        await Promise.all(
          chunk.map(async (candidate) => {
            if (!candidate.profileText || candidate.profileText.trim().length < 100) return;

            const scoreCacheKey = buildScoreCacheKey({
              profileText: candidate.profileText,
              parsedRole,
              salary,
              jobLocation: job.location,
              isRemote: job.isRemote,
              weights,
            });

            try {
              const [rawBreakdown, acceptanceResult] = await Promise.allSettled([
                withRetry(() => scoreCandidateStructured(candidate.profileText!, parsedRole, salary, weights, auth.orgId, recruiterContext)),
                withRetry(() => predictAcceptance(candidate.profileText!, parsedRole, salary)),
              ]);
              if (rawBreakdown.status === "rejected") throw rawBreakdown.reason;
              const breakdown = applyLocationFitOverride(
                rawBreakdown.value,
                candidate.location,
                parsedRole.location,
                parsedRole.location_rules,
                job.isRemote,
                weights,
              );
              const acceptance = acceptanceResult.status === "fulfilled" ? acceptanceResult.value : null;
              await prisma.candidate.update({
                where: { id: candidate.id },
                data: {
                  ...deriveUpdateData(breakdown),
                  profileTextHash: scoreCacheKey,
                  ...(acceptance && {
                    acceptanceScore: acceptance.score,
                    acceptanceReason: JSON.stringify(acceptance),
                  }),
                },
              });
              scored++;
              send({ scored, total });
            } catch (err) {
              reportError(err, { route: "score-all", jobId: id, orgId: auth.orgId, candidateId: candidate.id });
              failed.push(candidate.id);
            }
          })
        );
      }

      // Final message signals completion to the client, including any failures.
      send({ scored, total, done: true, ...(failed.length > 0 && { failedIds: failed }) });
      controller.close();

      console.log(`[score-all] scored=${scored} of ${total}`);
      void recordUsage(auth.orgId, auth.userId, "score_all", { jobId: id, scored });
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
