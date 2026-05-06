import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized } from "@/lib/session";
import { extractTextFromPdf } from "@/lib/pdf";
import { scoreCandidateStructured, predictAcceptance, cleanCvText } from "@/lib/ai";
import type { ParsedRole } from "@/lib/ai";
import { applyLocationFitOverride, deriveUpdateData } from "@/lib/score-utils";
import { buildScoreCacheKey, safeParseJson } from "@/lib/utils";
import { getOrgScoringWeights } from "@/lib/scoring-config";
import { reportError } from "@/lib/error-reporting";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
];
const ALLOWED_EXTS = /\.(pdf|doc|docx|txt|md)$/i;

async function requireAccess(candidateId: string, auth: NonNullable<Awaited<ReturnType<typeof getAuth>>>) {
  const candidate = await prisma.candidate.findUnique({
    where: { id: candidateId },
    include: {
      job: {
        select: {
          orgId: true,
          parsedRole: true,
          salaryMin: true,
          salaryMax: true,
          isRemote: true,
          location: true,
        },
      },
    },
  });
  if (!candidate) return null;
  const orgId = candidate.job?.orgId ?? candidate.orgId;
  if (!auth.isOwner && orgId !== auth.orgId) return null;
  return candidate;
}

async function extractText(buffer: Buffer, mimeType: string, filename: string): Promise<string | null> {
  try {
    if (mimeType === "application/pdf" || filename.endsWith(".pdf")) {
      return await extractTextFromPdf(buffer);
    }
    if (
      mimeType === "application/msword" ||
      mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      filename.endsWith(".doc") ||
      filename.endsWith(".docx")
    ) {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      return result.value ?? null;
    }
    if (mimeType.startsWith("text/") || filename.endsWith(".txt") || filename.endsWith(".md")) {
      return buffer.toString("utf-8");
    }
    return null;
  } catch {
    return null;
  }
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await getAuth();
    if (!auth) return unauthorized();
    const { id } = await params;

    const candidate = await requireAccess(id, auth);
    if (!candidate) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const files = await prisma.candidateFile.findMany({
      where: { candidateId: id },
      select: { id: true, type: true, filename: true, mimeType: true, size: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json(files);
  } catch (err) {
    reportError(err, { route: "files:get", candidateId: id, orgId: auth.orgId });
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;

  const candidate = await requireAccess(id, auth);
  if (!candidate) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const file = formData.get("file");
  const type = (formData.get("type") as string | null) ?? "other";

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }
  if (!["cv", "cover_letter", "other"].includes(type)) {
    return NextResponse.json({ error: "Invalid type" }, { status: 400 });
  }
  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json({ error: "File too large (max 10 MB)" }, { status: 413 });
  }
  if (!ALLOWED_EXTS.test(file.name) && !ALLOWED_TYPES.includes(file.type)) {
    return NextResponse.json({ error: "File type not allowed. Use PDF, Word, or plain text." }, { status: 415 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const base64 = buffer.toString("base64");

  const created = await prisma.candidateFile.create({
    data: {
      candidateId: id,
      type,
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      data: base64,
      size: file.size,
    },
    select: { id: true, type: true, filename: true, mimeType: true, size: true, createdAt: true },
  });

  // For CV uploads: extract text, clean it, merge with any existing LinkedIn capture,
  // then update profileText and auto-score.
  // Done after saving so the file is always persisted even if parsing fails.
  if (type === "cv") {
    const rawExtracted = await extractText(buffer, file.type, file.name);
    if (rawExtracted && rawExtracted.trim().length > 100) {
      // Fix 1: Clean garbled PDF text through AI before scoring.
      // PDFs from complex multi-column layouts produce broken line breaks and jumbled
      // columns — cleanCvText() normalises this into readable prose.
      // Word docs extracted via mammoth are already clean; only PDFs need this.
      let cvText = rawExtracted.trim();
      if (file.name.toLowerCase().endsWith(".pdf") && cvText.length > 200) {
        try {
          cvText = await cleanCvText(cvText);
        } catch {
          // If cleaning fails, proceed with raw text rather than blocking the upload
        }
      }

      // Fix 2: Merge CV with an existing LinkedIn capture rather than discarding one.
      // LinkedIn provides current-role context and headline signal; a CV provides
      // detailed technical bullets and the full skills list. Together they score better.
      const existingText = candidate.profileText?.trim() ?? "";
      const hasLinkedInCapture = Boolean(candidate.profileCapturedAt) || candidate.source === "extension";

      let text: string;
      if (hasLinkedInCapture && existingText.length >= 500) {
        // Merge: LinkedIn text first (current role context), CV appended for detail
        text = `${existingText}\n\n--- CV ---\n\n${cvText}`.slice(0, 50000);
      } else {
        // No meaningful LinkedIn capture — use whichever source is richer
        text = cvText.length > existingText.length + 500 ? cvText : existingText || cvText;
      }
      const updates: Record<string, unknown> = {
        profileText: text,
        profileTextHash: null,
        matchScore: null,
        matchReason: null,
        scoreBreakdown: null,
        acceptanceScore: null,
        acceptanceReason: null,
        profileCapturedAt: new Date(),
        source: candidate.source === "manual" ? "manual" : candidate.source,
      };

      const parsedRole = safeParseJson<ParsedRole | null>(candidate.job?.parsedRole ?? null, null);
      let scored = false;
      if (parsedRole && candidate.job) {
        try {
          const salary = (candidate.job.salaryMin || candidate.job.salaryMax)
            ? { min: candidate.job.salaryMin ?? 0, max: candidate.job.salaryMax ?? 0 }
            : null;
          const weights = await getOrgScoringWeights(auth.orgId);
          const [rawBreakdown, acceptanceResult] = await Promise.allSettled([
            scoreCandidateStructured(text, parsedRole, salary, weights),
            predictAcceptance(text, parsedRole, salary),
          ]);
          if (rawBreakdown.status === "fulfilled") {
            const breakdown = applyLocationFitOverride(
              rawBreakdown.value,
              candidate.location,
              parsedRole.location ?? candidate.job.location ?? "",
              parsedRole.location_rules,
              candidate.job.isRemote,
              weights,
            );
            Object.assign(updates, deriveUpdateData(breakdown));
            updates.profileTextHash = buildScoreCacheKey({
              profileText: text,
              parsedRole,
              salary,
              jobLocation: candidate.job.location,
              isRemote: candidate.job.isRemote,
            });
            if (acceptanceResult.status === "fulfilled") {
              updates.acceptanceScore = acceptanceResult.value.score;
              updates.acceptanceReason = JSON.stringify(acceptanceResult.value);
            }
            scored = true;
          } else {
            reportError(rawBreakdown.reason, { route: "cv-upload:score", candidateId: id, orgId: auth.orgId });
          }
        } catch (err) {
          reportError(err, { route: "cv-upload:score", candidateId: id, orgId: auth.orgId });
        }
      }

      await prisma.candidate.update({ where: { id }, data: updates });
      return NextResponse.json({ ...created, scored }, { status: 201 });
    }
  }

  const scored = false;
  return NextResponse.json({ ...created, scored }, { status: 201 });
  } catch (err) {
    reportError(err, { route: "files:post", candidateId: id, orgId: auth.orgId });
    return NextResponse.json({ error: "Server error — please try again" }, { status: 500 });
  }
}
