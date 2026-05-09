/**
 * Q2.3 server-side support — given a LinkedIn URL, tell the extension which
 * of the user's active jobs already include this candidate, and whether the
 * person exists in the org-wide talent pool.
 *
 * The extension's content script can call this when the user lands on a
 * LinkedIn profile and surface a proactive prompt: "Already in 2 jobs (Senior
 * Engineer · Sales Lead) — open in RecruitMe?" or "In your library but not
 * on any active job — add to one?".
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyExtensionAuth, jobsWhere } from "@/lib/session";
import { extensionCorsHeaders } from "@/lib/extension-cors";
import { normaliseLinkedInUrl } from "@/lib/linkedin";
import { getAccessibleOrgIds } from "@/lib/org-access";

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: extensionCorsHeaders(req) });
}

export async function GET(req: Request) {
  const auth = await verifyExtensionAuth(req);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: extensionCorsHeaders(req) });
  }

  const url = new URL(req.url);
  const rawUrl = url.searchParams.get("url");
  if (!rawUrl) {
    return NextResponse.json({ error: "url query param required" }, { status: 400, headers: extensionCorsHeaders(req) });
  }

  let normUrl: string;
  try {
    normUrl = normaliseLinkedInUrl(rawUrl);
  } catch {
    return NextResponse.json({ error: "Invalid LinkedIn URL" }, { status: 400, headers: extensionCorsHeaders(req) });
  }

  // All matches by URL — viewer sees their own org plus any orgs whose
  // libraries they've been granted access to (cross-org subscription).
  const accessibleOrgIds = await getAccessibleOrgIds(auth);
  const matches = await prisma.candidate.findMany({
    where: {
      linkedinUrl: normUrl,
      ...(accessibleOrgIds === null ? {} : {
        OR: [
          { job: { orgId: { in: accessibleOrgIds } } },
          { jobId: null, orgId: { in: accessibleOrgIds } },
        ],
      }),
    },
    select: {
      id: true,
      name: true,
      matchScore: true,
      status: true,
      jobId: true,
      profileText: true,
      createdAt: true,
      job: { select: { id: true, title: true, company: true, status: true } },
    },
  });

  // Split into "on an active job in the user's view" vs "in library only".
  const allowedJobs = await prisma.job.findMany({
    where: { status: "active", ...jobsWhere(auth) },
    select: { id: true, title: true, company: true },
  });
  const activeJobIds = new Set(allowedJobs.map((j) => j.id));

  const onActiveJobs = matches
    .filter((m) => m.jobId && activeJobIds.has(m.jobId) && m.job?.status === "active")
    .map((m) => ({
      candidateId: m.id,
      jobId: m.jobId,
      jobTitle: m.job?.title ?? "Active job",
      jobCompany: m.job?.company ?? null,
      matchScore: m.matchScore,
      status: m.status,
    }));

  const inLibrary = matches.some((m) => Boolean(m.profileText));
  // Pick a representative candidate ID for library-only logging — used by the
  // bubble when the candidate is in the library but not on any active job, so
  // the recruiter can still log "messaged" / "called" against that record.
  // Prefer one that has profileText (more useful) and the most recent.
  const libraryCandidateId = matches
    .filter((m) => Boolean(m.profileText))
    .sort((a, b) => (b.createdAt?.getTime?.() ?? 0) - (a.createdAt?.getTime?.() ?? 0))[0]?.id
    ?? matches[0]?.id
    ?? null;

  // For "add to job" suggestions: any active job the candidate is NOT yet on.
  const jobIdsWithCandidate = new Set(onActiveJobs.map((m) => m.jobId).filter(Boolean) as string[]);
  const suggestedJobs = allowedJobs.filter((j) => !jobIdsWithCandidate.has(j.id));

  // Recent contact events — surfaces who last reached out so agents don't double-up.
  const candidateIds = matches.map((m) => m.id);
  const contactEvents = candidateIds.length > 0
    ? await prisma.contactEvent.findMany({
        where: { candidateId: { in: candidateIds }, ...(!auth.isOwner ? { orgId: auth.orgId } : {}) },
        orderBy: { createdAt: "desc" },
        take: 3,
        select: { userName: true, type: true, note: true, jobId: true, createdAt: true },
      })
    : [];

  // Resolve role titles for the contact rows so the bubble can render
  // "Kasia messaged · re: Senior Java Developer" without an extra round-trip.
  const contactJobIds = [...new Set(contactEvents.map((e) => e.jobId).filter((id): id is string => Boolean(id)))];
  const contactJobs = contactJobIds.length === 0 ? [] : await prisma.job.findMany({
    where: { id: { in: contactJobIds } },
    select: { id: true, title: true },
  });
  const contactJobTitleById = new Map(contactJobs.map((j) => [j.id, j.title]));

  const now = Date.now();
  const recentContacts = contactEvents.map((e) => {
    const diffDays = Math.round((now - new Date(e.createdAt).getTime()) / 86_400_000);
    const relativeDate = diffDays === 0 ? "today" : diffDays === 1 ? "yesterday" : `${diffDays}d ago`;
    return {
      userName: e.userName,
      type: e.type,
      note: e.note,
      relativeDate,
      jobId: e.jobId ?? null,
      jobTitle: e.jobId ? contactJobTitleById.get(e.jobId) ?? null : null,
    };
  });

  return NextResponse.json({
    normalisedUrl: normUrl,
    onActiveJobs,
    inLibrary,
    libraryCandidateId,
    suggestedJobs: suggestedJobs.slice(0, 5),
    recentContacts,
  }, { headers: extensionCorsHeaders(req) });
}
