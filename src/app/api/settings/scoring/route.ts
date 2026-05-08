import { NextResponse } from "next/server";
import { getAuth, unauthorized } from "@/lib/session";
import {
  getOrgScoringWeights,
  saveOrgScoringWeights,
  normaliseWeights,
  DEFAULT_SCORING_WEIGHTS,
  type ScoringWeights,
} from "@/lib/scoring-config";
import { z } from "zod";

const WeightsSchema = z.object({
  must_have:        z.number().min(0).max(1),
  skill_fit:        z.number().min(0).max(1),
  location_fit:     z.number().min(0).max(1),
  seniority_fit:    z.number().min(0).max(1),
  title_fit:        z.number().min(0).max(1),
  domain_fit:       z.number().min(0).max(1),
  nice_to_have_fit: z.number().min(0).max(1),
});

export async function GET() {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const weights = await getOrgScoringWeights(auth.orgId);
  return NextResponse.json({ weights, defaults: DEFAULT_SCORING_WEIGHTS });
}

export async function PUT(req: Request) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  // Org-wide scoring weights affect every user in the org. Restrict editing
  // to owners so a single recruiter can't accidentally retune everyone's
  // scoring while experimenting.
  if (!auth.isOwner) {
    return NextResponse.json(
      { error: "Only the org owner can change org-wide scoring weights. Use per-job overrides on the job page instead." },
      { status: 403 }
    );
  }

  const body = WeightsSchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) {
    return NextResponse.json({ error: body.error.flatten() }, { status: 422 });
  }

  const normalised = normaliseWeights(body.data as ScoringWeights);
  await saveOrgScoringWeights(auth.orgId, normalised);
  return NextResponse.json({ weights: normalised });
}

export async function DELETE() {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  if (!auth.isOwner) {
    return NextResponse.json(
      { error: "Only the org owner can reset org-wide scoring weights." },
      { status: 403 }
    );
  }
  await saveOrgScoringWeights(auth.orgId, DEFAULT_SCORING_WEIGHTS);
  return NextResponse.json({ weights: DEFAULT_SCORING_WEIGHTS });
}
