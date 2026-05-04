import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized } from "@/lib/session";
import { generateCandidateProfileSections } from "@/lib/ai";
import { generateProfileDocx } from "@/lib/generate-candidate-profile-doc";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require("pdf-parse") as (buf: Buffer) => Promise<{ text: string }>;
import mammoth from "mammoth";

export const dynamic = "force-dynamic";

const JsonBodySchema = z.object({
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

async function extractFileText(file: File): Promise<string> {
  const buf = Buffer.from(await file.arrayBuffer());
  const name = file.name.toLowerCase();

  if (name.endsWith(".pdf")) {
    const result = await pdfParse(buf);
    return result.text ?? "";
  }
  if (name.endsWith(".docx") || name.endsWith(".doc")) {
    const result = await mammoth.extractRawText({ buffer: buf });
    return result.value ?? "";
  }
  // Plain text fallback
  return buf.toString("utf8");
}

export async function POST(req: Request) {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const contentType = req.headers.get("content-type") ?? "";

  // ── Documents flow (multipart/form-data) ──────────────────────────────────
  if (contentType.includes("multipart/form-data")) {
    let form: FormData;
    try { form = await req.formData(); } catch {
      return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
    }

    const candidateName = (form.get("candidateName") as string | null)?.trim() ?? "";
    if (!candidateName) {
      return NextResponse.json({ error: "Candidate name is required" }, { status: 422 });
    }

    const role          = ((form.get("role")          as string | null) ?? "").slice(0, 200);
    const dateAvailable = ((form.get("dateAvailable") as string | null) ?? "").slice(0, 100);

    const consultant = {
      name:  ((form.get("consultantName")  as string | null) ?? "").slice(0, 100),
      email: ((form.get("consultantEmail") as string | null) ?? "").slice(0, 200),
      phone: ((form.get("consultantPhone") as string | null) ?? "").slice(0, 50),
    };
    const manager = {
      name:  ((form.get("managerName")  as string | null) ?? "").slice(0, 100),
      email: ((form.get("managerEmail") as string | null) ?? "").slice(0, 200),
      phone: ((form.get("managerPhone") as string | null) ?? "").slice(0, 50),
    };

    const files = form.getAll("files") as File[];
    if (files.length === 0) {
      return NextResponse.json({ error: "At least one document is required" }, { status: 422 });
    }

    const texts = await Promise.all(files.map(extractFileText));
    const combinedText = texts.join("\n\n---\n\n").slice(0, 12000);

    if (!combinedText.trim()) {
      return NextResponse.json({ error: "Could not extract text from the uploaded files" }, { status: 422 });
    }

    const sections = await generateCandidateProfileSections(combinedText, candidateName);

    const referredDate = new Date().toLocaleDateString("en-NZ", {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
    });

    const buffer = await generateProfileDocx({
      candidateName,
      role,
      dateReferred:   referredDate,
      dateAvailable,
      consultant,
      manager,
      executiveSummary: sections.executiveSummary,
      workHistory:      sections.workHistory,
      qualifications:   sections.qualifications,
    });

    const safeName = candidateName.replace(/[^a-zA-Z0-9]/g, "_");
    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${safeName}_Candidate_Profile.docx"`,
        "Content-Length": String(buffer.length),
        "Cache-Control": "no-store",
      },
    });
  }

  // ── Library flow (application/json) ───────────────────────────────────────
  const result = JsonBodySchema.safeParse(await req.json().catch(() => ({})));
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

  const buffer = await generateProfileDocx({
    candidateName:  candidate.name,
    role:           role || candidate.job?.title || "",
    dateReferred:   referredDate,
    dateAvailable,
    consultant,
    manager,
    executiveSummary: sections.executiveSummary,
    workHistory:      sections.workHistory,
    qualifications:   sections.qualifications,
  });

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
