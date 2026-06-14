import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized, requireJobAccess } from "@/lib/session";
import { isCrmEnabled } from "@/lib/feature-flags";

const CreateSubmissionSchema = z.object({
  clientId:  z.string().optional().nullable(),
  matchScore: z.number().int().min(0).max(100).optional().nullable(),
  cvVersion: z.string().max(100).optional().nullable(),
  notes:     z.string().max(2000).optional().nullable(),
  status:    z.enum(["sent", "viewed", "interested", "rejected", "on_hold"]).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isCrmEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const { id: jobId } = await params;
  const body = await req.json().catch(() => ({}));
  const { candidateId, ...rest } = body as { candidateId?: string } & Record<string, unknown>;

  if (!candidateId) {
    return NextResponse.json({ error: "candidateId is required" }, { status: 422 });
  }

  const result = CreateSubmissionSchema.safeParse(rest);
  if (!result.success) {
    return NextResponse.json({ error: result.error.flatten() }, { status: 422 });
  }

  // Verify candidate belongs to this job and org
  const candidate = await prisma.candidate.findFirst({
    where: {
      id: candidateId,
      jobId,
      ...(auth.isOwner ? {} : { orgId: auth.orgId ?? "__none__" }),
    },
    select: { id: true, matchScore: true },
  });
  if (!candidate) return NextResponse.json({ error: "Candidate not found" }, { status: 404 });

  // A supplied clientId must belong to the caller's org (audit L1) — the
  // candidate is already org-scoped above, but clientId comes from the body.
  if (result.data.clientId) {
    const orgScope = auth.isOwner ? {} : { orgId: auth.orgId ?? "__none__" };
    const client = await prisma.client.findFirst({ where: { id: result.data.clientId, ...orgScope }, select: { id: true } });
    if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }

  const submission = await prisma.submission.create({
    data: {
      orgId: auth.orgId ?? "",
      jobId,
      candidateId,
      submittedBy: auth.userId,
      matchScore: result.data.matchScore ?? candidate.matchScore ?? null,
      clientId: result.data.clientId ?? null,
      cvVersion: result.data.cvVersion ?? null,
      notes: result.data.notes ?? null,
      status: result.data.status ?? "sent",
    },
  });

  // Auto-create client_feedback reminder 7 days out
  if (submission.clientId) {
    await prisma.reminder.create({
      data: {
        orgId: auth.orgId ?? "",
        userId: auth.userId,
        candidateId,
        jobId,
        clientId: submission.clientId,
        type: "client_feedback",
        dueAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        note: `Follow up on submission for candidate`,
      },
    });
  }

  return NextResponse.json(submission, { status: 201 });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isCrmEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const { id: jobId } = await params;
  const { error } = await requireJobAccess(jobId, auth);
  if (error) return error;

  // Submission has no `job` relation — query by the jobId column directly.
  const submissions = await prisma.submission.findMany({
    where: { jobId },
    orderBy: { submittedAt: "desc" },
    include: {
      candidate: { select: { id: true, name: true, headline: true, status: true, matchScore: true } },
      client:    { select: { id: true, name: true } },
    },
  });

  return NextResponse.json(submissions);
}
