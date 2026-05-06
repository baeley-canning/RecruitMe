import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized } from "@/lib/session";
import { normaliseWeights, type ScoringWeights } from "@/lib/scoring-config";

const WeightsSchema = z.object({
  must_have:        z.number().min(0).max(1),
  skill_fit:        z.number().min(0).max(1),
  location_fit:     z.number().min(0).max(1),
  seniority_fit:    z.number().min(0).max(1),
  title_fit:        z.number().min(0).max(1),
  domain_fit:       z.number().min(0).max(1),
  nice_to_have_fit: z.number().min(0).max(1),
});

const PostSchema = z.object({
  name:    z.string().trim().min(1).max(60),
  weights: WeightsSchema,
});

export async function GET() {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const presets = await prisma.scoringWeightPreset.findMany({
    where: auth.isOwner ? {} : { orgId: auth.orgId },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, weights: true, createdAt: true },
  });

  return NextResponse.json(presets);
}

export async function POST(req: Request) {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const parsed = PostSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });
  }

  const normalised = normaliseWeights(parsed.data.weights as ScoringWeights);
  const preset = await prisma.scoringWeightPreset.create({
    data: {
      orgId: auth.orgId ?? null,
      name: parsed.data.name,
      weights: JSON.stringify(normalised),
    },
  });

  return NextResponse.json(preset);
}
