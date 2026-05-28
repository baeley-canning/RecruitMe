import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized } from "@/lib/session";
import { sendOutreachEmail, sendRejectionEmail } from "@/lib/email";

const SendEmailSchema = z.object({
  type:    z.enum(["outreach", "rejection"]),
  to:      z.string().email(),
  message: z.string().max(5000).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; candidateId: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const { id: jobId, candidateId } = await params;

  const result = SendEmailSchema.safeParse(await req.json().catch(() => ({})));
  if (!result.success) {
    return NextResponse.json({ error: result.error.flatten() }, { status: 422 });
  }

  const [candidate, job, user] = await Promise.all([
    prisma.candidate.findFirst({
      where: { id: candidateId, jobId, ...(auth.isOwner ? {} : { orgId: auth.orgId ?? "__none__" }) },
      select: { id: true, name: true },
    }),
    prisma.job.findFirst({
      where: { id: jobId, ...(auth.isOwner ? {} : { orgId: auth.orgId ?? "__none__" }) },
      select: { title: true, company: true },
    }),
    prisma.user.findUnique({ where: { id: auth.userId }, select: { username: true } }),
  ]);

  if (!candidate || !job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const company = job.company ?? "our company";

  try {
    if (result.data.type === "outreach") {
      if (!result.data.message?.trim()) {
        return NextResponse.json({ error: "message is required for outreach emails" }, { status: 422 });
      }
      await sendOutreachEmail({
        to: result.data.to,
        candidateName: candidate.name,
        recruiterName: user?.username ?? "The Recruitment Team",
        jobTitle: job.title,
        company,
        messageBody: result.data.message,
      });
    } else {
      await sendRejectionEmail({
        to: result.data.to,
        candidateName: candidate.name,
        jobTitle: job.title,
        company,
      });
    }

    // Record contact event
    await prisma.contactEvent.create({
      data: {
        candidateId,
        orgId: auth.orgId ?? "",
        userId: auth.userId,
        userName: user?.username ?? "system",
        jobId,
        type: "email",
        note: result.data.type === "outreach" ? "Outreach email sent" : "Rejection email sent",
      },
    }).catch(() => {}); // Non-fatal
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to send email";
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  return NextResponse.json({ sent: true });
}
