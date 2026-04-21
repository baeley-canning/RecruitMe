import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generateJobAd } from "@/lib/ai";
import type { ParsedRole } from "@/lib/ai";
import { safeParseJson } from "@/lib/utils";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;
  const { job, error } = await requireJobAccess(id, auth);
  if (error || !job) return error;

  const parsedRole = safeParseJson<ParsedRole | null>(job.parsedRole, null);
  if (!parsedRole) return NextResponse.json({ error: "Job not parsed yet — parse it first" }, { status: 422 });

  const ad = await generateJobAd(parsedRole, job.company, job.rawJd);
  return NextResponse.json(ad);
}
