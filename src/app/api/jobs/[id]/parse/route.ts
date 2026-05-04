import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { parseJobDescription } from "@/lib/ai";
import type { ParsedRole } from "@/lib/ai";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";
import { recordUsage } from "@/lib/usage";
import { safeParseJson } from "@/lib/utils";

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
    const existing = safeParseJson<ParsedRole | null>(job.parsedRole, null);
    const parsedRole = await parseJobDescription(job.rawJd);

    // Preserve dismissals the recruiter made on the previous analysis.
    if (existing?.dismissed_skill_notes?.length) {
      parsedRole.dismissed_skill_notes = existing.dismissed_skill_notes;
    }

    // Save parsed role back to job
    await prisma.job.update({
      where: { id },
      data: { parsedRole: JSON.stringify(parsedRole) },
    });

    void recordUsage(auth.orgId, auth.userId, "parse", { jobId: id });
    return NextResponse.json({ parsedRole });
  } catch (err) {
    console.error("JD parse error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "AI parsing failed" },
      { status: 500 }
    );
  }
}
