import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getAuth } from "@/lib/session";
import { normaliseLinkedInUrl } from "@/lib/linkedin";
import { hasFullCandidateProfile } from "@/lib/candidate-profile";
import { CandidatesLibraryClient } from "@/components/candidates-library-client";

export const dynamic = "force-dynamic";

export default async function CandidatesPage() {
  const auth = await getAuth();
  if (!auth) redirect("/login");

  const rows = await prisma.candidate.findMany({
    where: {
      profileText: { not: null },
      ...(auth.isOwner ? {} : {
        OR: [
          { job: { orgId: auth.orgId } },
          { jobId: null, orgId: auth.orgId },
        ],
      }),
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      headline: true,
      location: true,
      linkedinUrl: true,
      profileText: true,
      matchScore: true,
      source: true,
      status: true,
      notes: true,
      profileCapturedAt: true,
      createdAt: true,
      archivedJobTitle: true,
      archivedJobCompany: true,
      job: { select: { id: true, title: true, company: true } },
      files: {
        select: { id: true, type: true, filename: true, size: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      },
    },
  });

  // Manual candidates (CV upload) bypass captured-profile thresholds because their CVs are often shorter.
  const withProfile = rows.filter((row) => row.source === "manual" || hasFullCandidateProfile(row));

  // Deduplicate by LinkedIn URL, keep freshest profile per person.
  type Row = typeof withProfile[number];
  const byUrl = new Map<string, Row>();
  const noUrl: Row[] = [];

  for (const row of withProfile) {
    if (!row.linkedinUrl) { noUrl.push(row); continue; }
    let norm: string;
    try { norm = normaliseLinkedInUrl(row.linkedinUrl); } catch { noUrl.push(row); continue; }

    const existing = byUrl.get(norm);
    if (!existing) { byUrl.set(norm, row); continue; }
    const rowAge = row.profileCapturedAt ?? row.createdAt;
    const existAge = existing.profileCapturedAt ?? existing.createdAt;
    if (rowAge > existAge) byUrl.set(norm, row);
  }

  const candidates = [...byUrl.values(), ...noUrl].sort((a, b) => {
    const aDate = a.profileCapturedAt ?? a.createdAt;
    const bDate = b.profileCapturedAt ?? b.createdAt;
    return bDate > aDate ? 1 : -1;
  });

  const serializedCandidates = candidates.map((candidate) => {
    const rest: Omit<typeof candidate, "profileText"> & { profileText?: string | null } = { ...candidate };
    delete rest.profileText;
    return {
      ...rest,
      profileCapturedAt: candidate.profileCapturedAt?.toISOString() ?? null,
      createdAt: candidate.createdAt.toISOString(),
      files: candidate.files.map((file) => ({
        ...file,
        createdAt: file.createdAt.toISOString(),
      })),
    };
  });

  return <CandidatesLibraryClient candidates={serializedCandidates} />;
}
