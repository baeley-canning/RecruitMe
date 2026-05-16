import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";

const SavedSearchBodySchema = z.object({
  name: z.string().trim().min(1, "name is required").max(100),
  queries: z.array(z.string()).min(1, "queries must contain at least one entry"),
  location: z.string().trim().min(1, "location is required").max(100),
  target: z.number().int().positive().max(100).optional(),
});

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;

  const { error } = await requireJobAccess(id, auth);
  if (error) return error;

  const rows = await prisma.savedSearch.findMany({
    where: { jobId: id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      queries: true,
      location: true,
      target: true,
      lastRunAt: true,
      lastResultCount: true,
      createdAt: true,
    },
  });

  return NextResponse.json(rows);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;

  const { job, error } = await requireJobAccess(id, auth);
  if (error || !job) return error;

  const parsed = SavedSearchBodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const body = parsed.data;

  const target = body.target ?? 20;

  // Cap queries to keep payload reasonable; trim whitespace; drop empties.
  const queries = body.queries
    .map((q) => q.trim())
    .filter(Boolean)
    .slice(0, 20);

  if (queries.length === 0) {
    return NextResponse.json({ error: "queries must contain at least one non-empty string" }, { status: 400 });
  }

  try {
    const saved = await prisma.savedSearch.create({
      data: {
        jobId: id,
        orgId: job.orgId ?? null,
        name: body.name.slice(0, 100),
        queries: JSON.stringify(queries),
        location: body.location.slice(0, 100),
        target,
      },
    });
    return NextResponse.json(saved);
  } catch (err) {
    // P2002 = Prisma unique constraint violation. We turn that into a friendly
    // 409 instead of a 500 so the UI can show "name already used" inline.
    if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2002") {
      return NextResponse.json({ error: "A saved search with this name already exists for this job." }, { status: 409 });
    }
    throw err;
  }
}
