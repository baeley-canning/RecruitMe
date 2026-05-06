import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";

// Cap matches the candidate-list page size — there's no realistic UX path that
// requires deleting more than 500 candidates in a single request, and this
// guards against runaway clients (or malicious payloads) flooding the DB layer.
const BodySchema = z.object({
  ids: z.array(z.string().min(1).max(40)).min(1).max(500),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;
  const { error } = await requireJobAccess(id, auth);
  if (error) return error;

  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "ids must be an array of 1–500 strings" }, { status: 422 });
  }

  const { count } = await prisma.candidate.deleteMany({
    where: { id: { in: parsed.data.ids }, jobId: id },
  });

  return NextResponse.json({ deleted: count });
}
