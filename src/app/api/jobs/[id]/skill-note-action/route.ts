import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";
import { safeParseJson } from "@/lib/utils";
import type { ParsedRole } from "@/lib/ai";

const Schema = z.discriminatedUnion("action", [
  z.object({
    skill: z.string().min(1).max(200),
    action: z.literal("accept"),
    alternative: z.string().min(1).max(200),
  }),
  z.object({
    skill: z.string().min(1).max(200),
    action: z.literal("dismiss"),
  }),
]);

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;
  const { job, error } = await requireJobAccess(id, auth);
  if (error || !job) return error;

  const body = Schema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) {
    return NextResponse.json({ error: body.error.flatten() }, { status: 422 });
  }

  const parsedRole = safeParseJson<ParsedRole | null>(job.parsedRole, null);
  if (!parsedRole) {
    return NextResponse.json({ error: "Job has not been analysed yet" }, { status: 400 });
  }

  let updated: ParsedRole = {
    ...parsedRole,
    nice_to_haves: [...parsedRole.nice_to_haves],
    skills_preferred: [...parsedRole.skills_preferred],
    dismissed_skill_notes: [...(parsedRole.dismissed_skill_notes ?? [])],
  };

  if (body.data.action === "accept") {
    const { alternative } = body.data;
    // Idempotent — don't add duplicates
    if (!updated.nice_to_haves.some((item) => item.toLowerCase() === alternative.toLowerCase())) {
      updated.nice_to_haves = [...updated.nice_to_haves, alternative];
    }
    if (!updated.skills_preferred.some((item) => item.toLowerCase() === alternative.toLowerCase())) {
      updated.skills_preferred = [...updated.skills_preferred, alternative];
    }
  }

  if (body.data.action === "dismiss") {
    const { skill } = body.data;
    const dismissed = updated.dismissed_skill_notes ?? [];
    if (!dismissed.includes(skill)) {
      updated = { ...updated, dismissed_skill_notes: [...dismissed, skill] };
    }
  }

  await prisma.job.update({
    where: { id },
    data: { parsedRole: JSON.stringify(updated) },
  });

  return NextResponse.json({ parsedRole: updated });
}
