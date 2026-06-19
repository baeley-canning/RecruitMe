import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { isSeekProfileUrl, normaliseSeekUrl } from "@/lib/seek";
import { getAuth, unauthorized } from "@/lib/session";

async function requireCandidateLibraryAccess(
  candidateId: string,
  auth: Awaited<ReturnType<typeof getAuth>>
) {
  if (!auth) return { candidate: null, error: unauthorized() };

  const candidate = await prisma.candidate.findUnique({
    where: { id: candidateId },
    include: {
      job: { select: { id: true, title: true, company: true, orgId: true } },
      files: {
        select: { id: true, type: true, filename: true, mimeType: true, size: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      },
    },
  });

  if (!candidate) {
    return { candidate: null, error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }
  // candidate.orgId is the canonical org per schema.prisma — "copied from
  // job.orgId on create; preserved after job deletion for auth scoping". Job
  // is only consulted when the candidate row predates the orgId column.
  // Reversing this priority let cross-org notes leak whenever a job's
  // orgId disagreed with the candidate's preserved orgId.
  const orgId = candidate.orgId ?? candidate.job?.orgId ?? null;
  if (!auth.isOwner && orgId !== auth.orgId) {
    return { candidate: null, error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  // Defence in depth: if job.orgId disagrees with the canonical orgId, the
  // row's history is suspect — strip the sensitive freeform fields rather
  // than risk leaking another org's notes.
  if (
    candidate.job?.orgId &&
    candidate.orgId &&
    candidate.job.orgId !== candidate.orgId &&
    !auth.isOwner
  ) {
    candidate.notes = null;
    candidate.screeningData = null;
    candidate.interviewNotes = null;
    candidate.statusHistory = null;
  }
  return { candidate, error: null };
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;
  const { candidate, error } = await requireCandidateLibraryAccess(id, auth);
  if (error) return error;

  // Also fetch all other jobs this person appears in (by LinkedIn URL).
  let otherJobs: { id: string; title: string; company: string | null; matchScore: number | null; status: string }[] = [];
  if (candidate!.linkedinUrl) {
    const others = await prisma.candidate.findMany({
      where: {
        linkedinUrl: candidate!.linkedinUrl,
        id: { not: id },
        ...(auth.isOwner ? {} : { OR: [{ job: { orgId: auth.orgId } }, { jobId: null, orgId: auth.orgId }] }),
      },
      select: {
        matchScore: true,
        status: true,
        job: { select: { id: true, title: true, company: true } },
      },
    });
    otherJobs = others.flatMap((o) => o.job ? [{
      id: o.job.id,
      title: o.job.title,
      company: o.job.company,
      matchScore: o.matchScore,
      status: o.status,
    }] : []);
  }

  return NextResponse.json({ ...candidate, otherJobs });
}

const PatchSchema = z.object({
  notes: z.string().max(10_000).optional(),
  // Recruiter Suitability marker mirroring JobAdder. Three valid states:
  //   "preferred" — boost in search results / shortlist preferences
  //   "excluded" — hide from search results
  //   null       — neutral (clears any prior setting)
  suitability: z.enum(["preferred", "excluded"]).nullable().optional(),
  // SEEK profile URL — empty string clears the link, a non-empty value must
  // be a real SEEK profile URL. Normalised before persisting.
  seekUrl: z
    .string()
    .max(500)
    .refine((v) => isSeekProfileUrl(v), { message: "Must be a valid SEEK profile URL" })
    .optional()
    .or(z.literal("")),
  // Manually-editable identity links + contact fields. Empty string clears the
  // value (→ null); a non-empty value is validated. The owner sets these by hand
  // (JobAdder has no API on this plan; LinkedIn/contact details come from manual
  // entry until enrichment fills them).
  linkedinUrl: z.string().max(500).url({ message: "Must be a valid URL (https://…)" }).optional().or(z.literal("")),
  jobAdderUrl: z.string().max(500).url({ message: "Must be a valid URL (https://…)" }).optional().or(z.literal("")),
  phone: z.string().max(50).optional().or(z.literal("")),
  email: z.string().max(200).email({ message: "Must be a valid email address" }).optional().or(z.literal("")),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;
  const { candidate, error } = await requireCandidateLibraryAccess(id, auth);
  if (error) return error;
  void candidate;

  const result = PatchSchema.safeParse(await req.json().catch(() => ({})));
  if (!result.success) return NextResponse.json({ error: result.error.flatten() }, { status: 422 });

  const { seekUrl, linkedinUrl, jobAdderUrl, phone, email, ...rest } = result.data;
  // Trim, and treat a blank string as an explicit clear (→ null).
  const blankToNull = (v: string | undefined) =>
    v === undefined ? undefined : v.trim() === "" ? null : v.trim();
  const data: Record<string, unknown> = {
    ...rest,
    ...(seekUrl !== undefined && { seekUrl: seekUrl ? normaliseSeekUrl(seekUrl) : null }),
    ...(linkedinUrl !== undefined && { linkedinUrl: blankToNull(linkedinUrl) }),
    ...(jobAdderUrl !== undefined && { jobAdderUrl: blankToNull(jobAdderUrl) }),
    ...(phone !== undefined && { phone: blankToNull(phone) }),
    ...(email !== undefined && { email: blankToNull(email) }),
  };

  try {
    const updated = await prisma.candidate.update({ where: { id }, data });
    return NextResponse.json(updated);
  } catch (e) {
    // @@unique([jobId, linkedinUrl]) — another candidate on this job already
    // holds that LinkedIn URL. Surface a clear 409 instead of a 500.
    if (e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "P2002") {
      return NextResponse.json(
        { error: "Another candidate on this job already has that LinkedIn URL." },
        { status: 409 },
      );
    }
    throw e;
  }
}
