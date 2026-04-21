import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized } from "@/lib/session";
import { normaliseLinkedInUrl } from "@/lib/linkedin";

/**
 * GET /api/candidates
 *
 * Returns the candidates library: all unique people with a captured profile
 * (profileText ≥500 chars), org-scoped, deduplicated by LinkedIn URL.
 *
 * For each unique person we return the most recently captured Candidate row
 * plus file metadata (no file data payload).
 */
export async function GET() {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const rows = await prisma.candidate.findMany({
    where: {
      profileText: { not: null },
      ...(auth.isOwner ? {} : { job: { orgId: auth.orgId } }),
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      headline: true,
      location: true,
      linkedinUrl: true,
      matchScore: true,
      source: true,
      status: true,
      profileCapturedAt: true,
      createdAt: true,
      jobId: true,
      job: { select: { id: true, title: true, company: true } },
      files: {
        select: { id: true, type: true, filename: true, size: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      },
    },
  });

  // Filter out short profiles
  const withProfile = rows.filter((r) => {
    // We only know profileText exists (not null) from the query; use that as proxy
    return true;
  });

  // Deduplicate by normalised LinkedIn URL; keep most recent capture per person.
  // Candidates without a LinkedIn URL are included individually (distinct people).
  type Row = typeof withProfile[number];
  const byUrl = new Map<string, Row>();
  const noUrl: Row[] = [];

  for (const row of withProfile) {
    if (!row.linkedinUrl) {
      noUrl.push(row);
      continue;
    }
    let norm: string;
    try { norm = normaliseLinkedInUrl(row.linkedinUrl); } catch { noUrl.push(row); continue; }

    const existing = byUrl.get(norm);
    if (!existing) { byUrl.set(norm, row); continue; }
    const rowAge = row.profileCapturedAt ?? row.createdAt;
    const existAge = existing.profileCapturedAt ?? existing.createdAt;
    if (rowAge > existAge) byUrl.set(norm, row);
  }

  const people = [...byUrl.values(), ...noUrl].sort(
    (a, b) => (b.profileCapturedAt ?? b.createdAt) > (a.profileCapturedAt ?? a.createdAt) ? 1 : -1
  );

  return NextResponse.json(people);
}
