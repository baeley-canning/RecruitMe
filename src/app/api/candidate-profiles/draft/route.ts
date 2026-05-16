import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized } from "@/lib/session";
import { generateCandidateProfileSections } from "@/lib/ai";
import { checkSpendCap, checkRateLimit } from "@/lib/usage";
import mammoth from "mammoth";

export const dynamic = "force-dynamic";

async function extractFileText(file: File): Promise<string> {
  const buf = Buffer.from(await file.arrayBuffer());
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf")) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfParse = require("pdf-parse") as (buf: Buffer) => Promise<{ text: string }>;
    const result = await pdfParse(buf);
    return result.text ?? "";
  }
  if (name.endsWith(".docx") || name.endsWith(".doc")) {
    const result = await mammoth.extractRawText({ buffer: buf });
    return result.value ?? "";
  }
  return buf.toString("utf8");
}

export async function POST(req: Request) {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  // Cost ceiling — this route fires up to 2 Claude calls per request
  // (extract + summary). Without this guard, a user could mash the
  // "Generate profile" button and silently bypass the daily $5 cap
  // because the underlying helpers don't thread orgId into the cost
  // recorder (separate Phase 4 fix). At-start check is enough; only
  // 2 calls per click means we can't blow past mid-loop.
  const spend = await checkSpendCap(auth.orgId);
  if (!spend.allowed) {
    return NextResponse.json({
      error: `Daily AI spend cap reached ($${spend.spentUsd.toFixed(2)} / $${spend.capUsd.toFixed(2)}). Try again tomorrow or raise AI_DAILY_SPEND_CAP_USD.`,
    }, { status: 429 });
  }
  // Per-event rate-limit reuses the parse bucket (also 2 Claude calls).
  const rateCheck = await checkRateLimit(auth.orgId, "parse");
  if (!rateCheck.allowed) {
    const waitMin = Math.ceil((rateCheck.retryAfterMs ?? 60_000) / 60_000);
    return NextResponse.json({ error: `Profile drafting rate limit reached. Try again in ~${waitMin} minute${waitMin !== 1 ? "s" : ""}.` }, { status: 429 });
  }

  const contentType = req.headers.get("content-type") ?? "";

  // ── Documents mode (multipart/form-data) ──────────────────────────────────
  if (contentType.includes("multipart/form-data")) {
    let form: FormData;
    try { form = await req.formData(); } catch {
      return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
    }

    const candidateName = (form.get("candidateName") as string | null)?.trim() ?? "";
    const targetRole    = (form.get("targetRole")    as string | null)?.trim() ?? "";
    if (!candidateName) return NextResponse.json({ error: "Candidate name is required" }, { status: 422 });
    if (!targetRole)    return NextResponse.json({ error: "Target role is required" }, { status: 422 });

    const files = form.getAll("files") as File[];
    if (files.length === 0) return NextResponse.json({ error: "At least one document is required" }, { status: 422 });

    const texts = await Promise.all(files.map(extractFileText));
    const combinedText = texts.join("\n\n---\n\n");

    if (!combinedText.trim()) {
      return NextResponse.json({ error: "Could not extract text from the uploaded files." }, { status: 422 });
    }

    const truncated = combinedText.length > 16000;
    const sourceText = combinedText.slice(0, 16000);

    const jdFileField = form.get("jdFile");
    const jdText = jdFileField && typeof jdFileField !== "string"
      ? ((await extractFileText(jdFileField as File)).slice(0, 4000) || undefined)
      : ((form.get("jdText") as string | null)?.slice(0, 4000) || undefined);

    const sections = await generateCandidateProfileSections(sourceText, candidateName, targetRole, jdText);

    return NextResponse.json({ candidateName, targetRole, sections, truncated, charCount: sourceText.length });
  }

  // ── Library mode (application/json) ───────────────────────────────────────
  const body = await req.json().catch(() => ({})) as {
    candidateId?: string;
    targetRole?: string;
    jdText?: string;
  };

  const { candidateId, targetRole, jdText } = body;

  if (!candidateId) return NextResponse.json({ error: "candidateId is required" }, { status: 422 });
  if (!targetRole?.trim()) return NextResponse.json({ error: "targetRole is required" }, { status: 422 });

  const candidate = await prisma.candidate.findUnique({
    where: { id: candidateId },
    select: {
      id: true, name: true, profileText: true, orgId: true,
      job: { select: { orgId: true, rawJd: true } },
    },
  });

  if (!candidate) return NextResponse.json({ error: "Candidate not found" }, { status: 404 });

  const orgId = candidate.job?.orgId ?? candidate.orgId;
  if (!auth.isOwner && orgId !== auth.orgId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!candidate.profileText?.trim()) {
    return NextResponse.json({ error: "Candidate has no profile text to generate from." }, { status: 422 });
  }

  const sourceText = candidate.profileText.slice(0, 16000);
  const truncated = candidate.profileText.length > 16000;
  const resolvedJd = jdText?.trim() || candidate.job?.rawJd?.trim() || undefined;

  const sections = await generateCandidateProfileSections(sourceText, candidate.name, targetRole, resolvedJd);

  return NextResponse.json({ candidateName: candidate.name, targetRole, sections, truncated, charCount: sourceText.length });
}
