import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";

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

  const body = await req.json().catch(() => null) as {
    name?: string;
    queries?: string[];
    location?: string;
    target?: number;
  } | null;

  if (!body || !body.name?.trim() || !Array.isArray(body.queries) || body.queries.length === 0 || !body.location?.trim()) {
    return NextResponse.json({ error: "name, queries (non-empty array), and location are required" }, { status: 400 });
  }

  const target = Number.isFinite(body.target) && body.target! > 0 && body.target! <= 100 ? Math.floor(body.target!) : 20;

  // Cap queries to keep payload reasonable; trim whitespace; drop empties.
  const queries = body.queries
    .map((q) => (typeof q === "string" ? q.trim() : ""))
    .filter(Boolean)
    .slice(0, 20);

  if (queries.length === 0) {
    return NextResponse.json({ error: "queries must contain at least one non-empty string" }, { status: 400 });
  }

  const saved = await prisma.savedSearch.create({
    data: {
      jobId: id,
      orgId: job.orgId ?? null,
      name: body.name.trim().slice(0, 100),
      queries: JSON.stringify(queries),
      location: body.location.trim().slice(0, 100),
      target,
    },
  });

  return NextResponse.json(saved);
}
