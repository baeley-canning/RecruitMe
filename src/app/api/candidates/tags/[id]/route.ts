import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized } from "@/lib/session";
import { isRemindersEnabled } from "@/lib/feature-flags";

const PatchTagSchema = z.object({
  label: z.string().min(1).max(50).trim().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

/** Resolve a tag within the caller's org (owner sees all). */
async function ownTag(id: string, auth: NonNullable<Awaited<ReturnType<typeof getAuth>>>) {
  return prisma.candidateTag.findFirst({
    where: { id, ...(auth.isOwner ? {} : { orgId: auth.orgId ?? "__none__" }) },
    select: { id: true },
  });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isRemindersEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const { id } = await params;
  if (!(await ownTag(id, auth))) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const result = PatchTagSchema.safeParse(await req.json().catch(() => ({})));
  if (!result.success) return NextResponse.json({ error: result.error.flatten() }, { status: 422 });

  try {
    const tag = await prisma.candidateTag.update({ where: { id }, data: result.data });
    return NextResponse.json(tag);
  } catch {
    // @@unique([orgId, label]) collision on rename.
    return NextResponse.json({ error: "A tag with that name already exists" }, { status: 409 });
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isRemindersEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const { id } = await params;
  if (!(await ownTag(id, auth))) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Assignments cascade (CandidateTagAssignment onDelete: Cascade).
  await prisma.candidateTag.delete({ where: { id } });
  return NextResponse.json({ deleted: true });
}
