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

  // Hard caps so a recruiter (or compromised account) can't inflate parsedRole
  // arrays indefinitely — every entry contributes tokens to every subsequent
  // scoring prompt and an unbounded list silently blows up cost.
  const MAX_LIST = 100;

  if (action === "dismiss-knockout") {
    if (!updated.dismissed_knockout_criteria!.includes(item)) {
      if (updated.dismissed_knockout_criteria!.length >= MAX_LIST) {
        return NextResponse.json({ error: `dismissed_knockout_criteria capped at ${MAX_LIST} entries` }, { status: 422 });
      }
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
      if (updated.promoted_visa_flags!.length >= MAX_LIST) {
        return NextResponse.json({ error: `promoted_visa_flags capped at ${MAX_LIST} entries` }, { status: 422 });
      }
      updated.promoted_visa_flags = [...updated.promoted_visa_flags!, item];
    }
    // Add to must_haves and skills_required if not already present
    if (!updated.must_haves.some((m) => m.toLowerCase() === itemLower)) {
      if (updated.must_haves.length >= MAX_LIST) {
        return NextResponse.json({ error: `must_haves capped at ${MAX_LIST} entries` }, { status: 422 });
      }
      updated.must_haves = [...updated.must_haves, item];
    }
    if (!updated.skills_required.some((s) => s.toLowerCase() === itemLower)) {
      if (updated.skills_required.length >= MAX_LIST) {
        return NextResponse.json({ error: `skills_required capped at ${MAX_LIST} entries` }, { status: 422 });
      }
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
