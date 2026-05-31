import { redirect } from "next/navigation";
import { getAuth } from "@/lib/session";
import { getLibraryCandidates, LIBRARY_PAGE_SIZE } from "@/lib/library";
import { CandidatesLibraryClient } from "@/components/candidates-library-client";

export const dynamic = "force-dynamic";

export default async function CandidatesPage() {
  const auth = await getAuth();
  if (!auth) redirect("/login");
  // Belt-and-braces: a non-owner with no orgId would otherwise have getAccessibleOrgIds
  // return [] (no rows) — safe, but redirecting to /login matches the sibling API guard
  // and avoids rendering an empty library for a half-onboarded user.
  if (!auth.isOwner && !auth.orgId) redirect("/login");

  // Cross-org grant expansion + dedupe + shared-org enrichment lives in
  // src/lib/library.ts so this loader and /api/candidates can't drift.
  // Cap the SSR fetch to the first page; the client loads more via nextCursor
  // and searches server-side, so the full library stays reachable.
  const { candidates, nextCursor } = await getLibraryCandidates(auth, { take: LIBRARY_PAGE_SIZE });

  const serializedCandidates = candidates.map((candidate) => ({
    id: candidate.id,
    name: candidate.name,
    headline: candidate.headline,
    location: candidate.location,
    linkedinUrl: candidate.linkedinUrl,
    jobAdderUrl: candidate.jobAdderUrl,
    phone: candidate.phone,
    email: candidate.email,
    photoFileId: candidate.photoFileId,
    matchScore: candidate.matchScore,
    source: candidate.source,
    importBatchId: candidate.importBatchId,
    status: candidate.status,
    notes: candidate.notes,
    sharedFromOrgName: candidate.sharedFromOrgName,
    profileCapturedAt: candidate.profileCapturedAt?.toISOString() ?? null,
    createdAt: candidate.createdAt.toISOString(),
    job: candidate.job
      ? { id: candidate.job.id, title: candidate.job.title, company: candidate.job.company }
      : null,
    archivedJobTitle: candidate.archivedJobTitle,
    archivedJobCompany: candidate.archivedJobCompany,
    files: candidate.files.map((file) => ({
      ...file,
      createdAt: file.createdAt.toISOString(),
    })),
  }));

  return <CandidatesLibraryClient candidates={serializedCandidates} initialNextCursor={nextCursor} />;
}
