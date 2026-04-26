import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { scoreCandidateStructured } from "@/lib/ai";
import type { ParsedRole } from "@/lib/ai";
import { applyLocationFitOverride, deriveUpdateData } from "@/lib/score-utils";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";

const CONCURRENCY = 3;
const COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes per job
const lastScored = new Map<string, number>();

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;

  const last = lastScored.get(id);
  if (last && Date.now() - last < COOLDOWN_MS) {
    const waitSec = Math.ceil((COOLDOWN_MS - (Date.now() - last)) / 1000);
    return NextResponse.json({ error: `Re-score all was just run. Wait ${waitSec}s before running again.` }, { status: 429 });
  }

  const { job, error } = await requireJobAccess(id, auth);
  if (error || !job) return error;
  if (!job.parsedRole) {
    return NextResponse.json({ error: "Parse the job description first." }, { status: 400 });
  }

  const candidates = await prisma.candidate.findMany({
    where: { jobId: id, profileText: { not: null } },
  });

  if (candidates.length === 0) {
    return NextResponse.json({ scored: 0, total: 0, message: "No candidates with profile text to score." });
  }

  lastScored.set(id, Date.now());

  const parsedRole = JSON.parse(job.parsedRole) as ParsedRole;
  const salary = (job.salaryMin || job.salaryMax)
    ? { min: job.salaryMin ?? 0, max: job.salaryMax ?? 0 }
    : null;

  let scored = 0;

  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const chunk = candidates.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (candidate) => {
        if (!candidate.profileText) return;
        try {
          const rawBreakdown = await scoreCandidateStructured(candidate.profileText, parsedRole, salary);
          const breakdown = applyLocationFitOverride(
            rawBreakdown,
            candidate.location,
            parsedRole.location,
            parsedRole.location_rules,
            job.isRemote,
          );
          await prisma.candidate.update({
            where: { id: candidate.id },
            data:  deriveUpdateData(breakdown),
          });
          scored++;
        } catch (err) {
          console.error(`Score failed for candidate ${candidate.id}:`, err);
        }
      })
    );
  }

  return NextResponse.json({ scored, total: candidates.length });
}
