import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";
import { safeParseJson } from "@/lib/utils";
import type { ParsedRole } from "@/lib/ai";

const Schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("dismiss-knockout"),  item: z.string().min(1).max(500) }),
  z.object({ action: z.literal("restore-knockout"),  item: z.string().min(1).max(500) }),
  z.object({ action: z.literal("promote-visa-flag"), item: z.string().min(1).max(500) }),
  z.object({ action: z.literal("demote-visa-flag"),  item: z.string().min(1).max(500) }),
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

  const updated: ParsedRole = {
    ...parsedRole,
    dismissed_knockout_criteria: [...(parsedRole.dismissed_knockout_criteria ?? [])],
    promoted_visa_flags: [...(parsedRole.promoted_visa_flags ?? [])],
    must_haves: [...parsedRole.must_haves],
    skills_required: [...parsedRole.skills_required],
  };

  const { action, item } = body.data;
  const itemLower = item.toLowerCase();

  if (action === "dismiss-knockout") {
    if (!updated.dismissed_knockout_criteria!.includes(item)) {
      updated.dismissed_knockout_criteria = [...updated.dismissed_knockout_criteria!, item];
    }
  }

  if (action === "restore-knockout") {
    updated.dismissed_knockout_criteria = updated.dismissed_knockout_criteria!.filter(
      (k) => k !== item
    );
  }

  if (action === "promote-visa-flag") {
    if (!updated.promoted_visa_flags!.includes(item)) {
      updated.promoted_visa_flags = [...updated.promoted_visa_flags!, item];
    }
    // Add to must_haves and skills_required if not already present
    if (!updated.must_haves.some((m) => m.toLowerCase() === itemLower)) {
      updated.must_haves = [...updated.must_haves, item];
    }
    if (!updated.skills_required.some((s) => s.toLowerCase() === itemLower)) {
      updated.skills_required = [...updated.skills_required, item];
    }
  }

  if (action === "demote-visa-flag") {
    updated.promoted_visa_flags = updated.promoted_visa_flags!.filter((v) => v !== item);
    // Remove from must_haves and skills_required
    updated.must_haves = updated.must_haves.filter((m) => m.toLowerCase() !== itemLower);
    updated.skills_required = updated.skills_required.filter((s) => s.toLowerCase() !== itemLower);
  }

  await prisma.job.update({
    where: { id },
    data: { parsedRole: JSON.stringify(updated) },
  });

  return NextResponse.json({ parsedRole: updated });
}
