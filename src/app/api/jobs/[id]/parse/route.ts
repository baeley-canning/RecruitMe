import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { parseJobDescription } from "@/lib/ai";
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

  try {
    const parsedRole = await parseJobDescription(job.rawJd);

    // Save parsed role back to job
    await prisma.job.update({
      where: { id },
      data: { parsedRole: JSON.stringify(parsedRole) },
    });

    return NextResponse.json({ parsedRole });
  } catch (err) {
    console.error("JD parse error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "AI parsing failed" },
      { status: 500 }
    );
  }
}
