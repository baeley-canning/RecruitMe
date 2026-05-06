import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { parseJobDescription } from "@/lib/ai";
import type { ParsedRole } from "@/lib/ai";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";
import { recordUsage } from "@/lib/usage";
import { safeParseJson } from "@/lib/utils";

function diffParsedRole(before: ParsedRole | null, after: ParsedRole): string[] {
  if (!before) return [];
  const changes: string[] = [];

  const listDiff = (label: string, a: string[], b: string[]) => {
    const added   = b.filter((x) => !a.some((y) => y.toLowerCase() === x.toLowerCase()));
    const removed = a.filter((x) => !b.some((y) => y.toLowerCase() === x.toLowerCase()));
    if (added.length)   changes.push(`${label}: added ${added.slice(0, 3).join(", ")}${added.length > 3 ? ` +${added.length - 3} more` : ""}`);
    if (removed.length) changes.push(`${label}: removed ${removed.slice(0, 3).join(", ")}${removed.length > 3 ? ` +${removed.length - 3} more` : ""}`);
  };

  if (before.title !== after.title) changes.push(`Title: "${before.title}" → "${after.title}"`);
  if (before.seniority_band !== after.seniority_band) changes.push(`Seniority: "${before.seniority_band}" → "${after.seniority_band}"`);
  if (before.salary_band !== after.salary_band) changes.push(`Salary: "${before.salary_band}" → "${after.salary_band}"`);
  if (before.location !== after.location) changes.push(`Location: "${before.location}" → "${after.location}"`);

  listDiff("Must-haves",    before.must_haves    ?? [], after.must_haves    ?? []);
  listDiff("Nice-to-haves", before.nice_to_haves ?? [], after.nice_to_haves ?? []);
  listDiff("Knockouts",     before.knockout_criteria ?? [], after.knockout_criteria ?? []);

  const beforeAnchors = before.anchor_terms ?? [];
  const afterAnchors  = after.anchor_terms  ?? [];
  if (JSON.stringify(beforeAnchors.slice().sort()) !== JSON.stringify(afterAnchors.slice().sort())) {
    changes.push(`Search anchors: ${afterAnchors.length ? afterAnchors.join(", ") : "none"}`);
  }

  return changes;
}

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

    // Preserve all recruiter overrides from the previous analysis.
    if (existing?.dismissed_skill_notes?.length) {
      parsedRole.dismissed_skill_notes = existing.dismissed_skill_notes;
    }
    if (existing?.dismissed_knockout_criteria?.length) {
      parsedRole.dismissed_knockout_criteria = existing.dismissed_knockout_criteria;
    }
    if (existing?.promoted_visa_flags?.length) {
      parsedRole.promoted_visa_flags = existing.promoted_visa_flags;
      // Re-apply promoted visa flags into must_haves so scoring stays consistent.
      for (const flag of existing.promoted_visa_flags) {
        const lower = flag.toLowerCase();
        if (!parsedRole.must_haves.some((m) => m.toLowerCase() === lower)) {
          parsedRole.must_haves = [...parsedRole.must_haves, flag];
        }
        if (!parsedRole.skills_required.some((s) => s.toLowerCase() === lower)) {
          parsedRole.skills_required = [...parsedRole.skills_required, flag];
        }
      }
    }

    // Save parsed role back to job
    await prisma.job.update({
      where: { id },
      data: { parsedRole: JSON.stringify(parsedRole) },
    });

    const changes = diffParsedRole(existing, parsedRole);
    void recordUsage(auth.orgId, auth.userId, "parse", { jobId: id });
    return NextResponse.json({ parsedRole, changes });
  } catch (err) {
    console.error("JD parse error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "AI parsing failed" },
      { status: 500 }
    );
  }
}
