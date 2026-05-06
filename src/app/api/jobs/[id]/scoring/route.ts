import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";
import {
  getJobScoringWeights,
  getOrgScoringWeights,
  normaliseWeights,
  DEFAULT_SCORING_WEIGHTS,
  type ScoringWeights,
} from "@/lib/scoring-config";

const WeightsSchema = z.object({
  must_have:        z.number().min(0).max(1),
  skill_fit:        z.number().min(0).max(1),
  location_fit:     z.number().min(0).max(1),
  seniority_fit:    z.number().min(0).max(1),
  title_fit:        z.number().min(0).max(1),
  domain_fit:       z.number().min(0).max(1),
  nice_to_have_fit: z.number().min(0).max(1),
});

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;

  const { job, error } = await requireJobAccess(id, auth);
  if (error || !job) return error;

  const weights = await getJobScoringWeights(job.scoringWeights, auth.orgId);
  const orgWeights = await getOrgScoringWeights(auth.orgId);
  return NextResponse.json({
    weights,
    defaults: DEFAULT_SCORING_WEIGHTS,
    // The "default" the editor's reset compares against is whatever the org
    // would resolve to without this job's override — so the recruiter can see
    // "back to org default" rather than "back to platform default".
    orgDefaults: orgWeights,
    hasOverride: Boolean(job.scoringWeights),
  });
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;

  const { error } = await requireJobAccess(id, auth);
  if (error) return error;

  const body = WeightsSchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) {
    return NextResponse.json({ error: body.error.flatten() }, { status: 422 });
  }

  const normalised = normaliseWeights(body.data as ScoringWeights);
  await prisma.job.update({
    where: { id },
    data: { scoringWeights: JSON.stringify(normalised) },
  });
  return NextResponse.json({ weights: normalised });
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

  await prisma.job.update({ where: { id }, data: { scoringWeights: null } });
  const orgWeights = await getOrgScoringWeights(auth.orgId);
  return NextResponse.json({ weights: orgWeights });
}
