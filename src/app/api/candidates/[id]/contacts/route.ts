import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, verifyAnyAuth, unauthorized } from "@/lib/session";

async function requireAccess(candidateId: string, orgId: string | null, isOwner: boolean) {
  const c = await prisma.candidate.findUnique({ where: { id: candidateId }, select: { orgId: true } });
  if (!c) return false;
  return isOwner || c.orgId === orgId;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;
  if (!await requireAccess(id, auth.orgId, auth.isOwner)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const events = await prisma.contactEvent.findMany({
    where: { candidateId: id },
    orderBy: { createdAt: "desc" },
    select: { id: true, type: true, note: true, userName: true, userId: true, jobId: true, createdAt: true },
  });
  // Resolve job titles so the UI can show "re: [Role]" without N+1 lookups.
  const jobIds = [...new Set(events.map((e) => e.jobId).filter((id): id is string => Boolean(id)))];
  const jobs = jobIds.length === 0 ? [] : await prisma.job.findMany({
    where: { id: { in: jobIds } },
    select: { id: true, title: true },
  });
  const titleById = new Map(jobs.map((j) => [j.id, j.title]));
  return NextResponse.json(events.map((e) => ({
    ...e,
    jobTitle: e.jobId ? titleById.get(e.jobId) ?? null : null,
  })));
}

const PostSchema = z.object({
  // ai_outreach_generated is logged by the AI outreach route so the UI can
  // show "outreach drafted N days ago" and warn before re-generating.
  type: z.enum(["message", "call", "email", "other", "ai_outreach_generated"]),
  note: z.string().max(500).optional(),
  // Which job this contact was about — lets the bubble surface "re: [Role]"
  // so a different recruiter on the same org knows which conversation it
  // continues. Optional for backward compat with old extension versions.
  jobId: z.string().min(1).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Accept both NextAuth session (web UI) and Basic auth (browser extension)
  const auth = await verifyAnyAuth(req) ?? await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;
  if (!await requireAccess(id, auth.orgId, auth.isOwner)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const parsed = PostSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });

  const { type, note, jobId } = parsed.data;

  // If jobId provided, verify the recruiter's org owns it and the candidate
  // is on it — prevents an attacker (or extension bug) tagging a contact
  // event against a job they shouldn't see.
  let resolvedJobId: string | null = null;
  if (jobId) {
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: { orgId: true, candidates: { where: { id }, select: { id: true } } },
    });
    const orgOk = auth.isOwner || job?.orgId === auth.orgId;
    const candidateOnJob = (job?.candidates ?? []).length > 0;
    if (job && orgOk && candidateOnJob) {
      resolvedJobId = jobId;
    }
    // Silent fall-through to null — bad jobId is logged as un-attributed
    // rather than rejecting the whole event.
  }

  const user = await prisma.user.findUnique({ where: { id: auth.userId }, select: { username: true } });
  const event = await prisma.contactEvent.create({
    data: {
      candidateId: id,
      orgId:    auth.orgId,
      userId:   auth.userId,
      userName: user?.username ?? auth.userId,
      type,
      note: note?.trim() || null,
      jobId: resolvedJobId,
    },
  });
  return NextResponse.json(event, { status: 201 });
}
