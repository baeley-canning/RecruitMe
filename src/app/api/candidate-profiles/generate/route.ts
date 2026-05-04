import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized } from "@/lib/session";
import { generateCandidateProfileSections } from "@/lib/ai";
import { generateProfileDocx } from "@/lib/generate-candidate-profile-doc";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  candidateId:   z.string().min(1),
  role:          z.string().max(200).default(""),
  dateAvailable: z.string().max(100).default(""),
  consultant: z.object({
    name:  z.string().max(100).default(""),
    email: z.string().max(200).default(""),
    phone: z.string().max(50).default(""),
  }).default({}),
  manager: z.object({
    name:  z.string().max(100).default(""),
    email: z.string().max(200).default(""),
    phone: z.string().max(50).default(""),
  }).default({}),
});

export async function POST(req: Request) {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const result = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!result.success) {
    return NextResponse.json({ error: result.error.flatten() }, { status: 422 });
  }

  const { candidateId, role, dateAvailable, consultant, manager } = result.data;

  const candidate = await prisma.candidate.findUnique({
    where: { id: candidateId },
    select: {
      id: true,
      name: true,
      profileText: true,
      orgId: true,
      job: { select: { orgId: true, title: true } },
    },
  });

  if (!candidate) {
    return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
  }

  const orgId = candidate.job?.orgId ?? candidate.orgId;
  if (!auth.isOwner && orgId !== auth.orgId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!candidate.profileText?.trim()) {
    return NextResponse.json({ error: "Candidate has no profile text to generate from." }, { status: 422 });
  }

  const sections = await generateCandidateProfileSections(candidate.profileText, candidate.name);

  const referredDate = new Date().toLocaleDateString("en-NZ", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const docData = {
    candidateName:  candidate.name,
    role:           role || candidate.job?.title || "",
    dateReferred:   referredDate,
    dateAvailable:  dateAvailable || "",
    consultant,
    manager,
    executiveSummary: sections.executiveSummary,
    workHistory:      sections.workHistory,
    qualifications:   sections.qualifications,
  };

  const buffer = await generateProfileDocx(docData);
  const safeName = candidate.name.replace(/[^a-zA-Z0-9]/g, "_");

  return new NextResponse(buffer as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${safeName}_Candidate_Profile.docx"`,
      "Content-Length": String(buffer.length),
      "Cache-Control": "no-store",
    },
  });
}
