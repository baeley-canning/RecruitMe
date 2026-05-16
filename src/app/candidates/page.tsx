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
  // Belt-and-braces: a non-owner with no orgId would otherwise have the
  // OR-clauses below collapse to `{ orgId: null }`, leaking every
  // orphaned/null-org candidate in the platform. The sibling API guards
  // this case; this page must too.
  if (!auth.isOwner && !auth.orgId) redirect("/login");

  const [rows, orgs] = await Promise.all([
    prisma.candidate.findMany({
      where: {
        // Library used to require a captured profileText, but manual + ATS-
        // imported candidates legitimately enter without one (their data is
        // in a CV file + metadata). Whitelist those sources so they show up.
        // Mirrors the same change in src/app/api/candidates/route.ts.
        OR: [
          { profileText: { not: null } },
          { source: { in: ["manual", "jobadder_import"] } },
        ],
        ...(auth.isOwner ? {} : {
          AND: {
            OR: [
              { job: { orgId: auth.orgId } },
              { jobId: null, orgId: auth.orgId },
            ],
            // Never surface orphan rows where both jobId AND orgId are null.
            NOT: { orgId: null, jobId: null },
          },
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
        orgId: true,
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
    }),
    // Owner only: fetch org names to label cross-org candidates
    auth.isOwner
      ? prisma.org.findMany({ select: { id: true, name: true } })
      : Promise.resolve([] as { id: string; name: string }[]),
  ]);

  const orgMap = new Map(orgs.map((o) => [o.id, o.name]));

  // Manual + JobAdder-imported candidates bypass captured-profile thresholds — their CVs/metadata
  // are the source of truth, not a scraped LinkedIn blob.
  const withProfile = rows.filter(
    (row) => row.source === "manual" || row.source === "jobadder_import" || hasFullCandidateProfile(row),
  );

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
      orgName: candidate.orgId ? (orgMap.get(candidate.orgId) ?? null) : null,
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
