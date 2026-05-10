import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized } from "@/lib/session";
import { extractTextFromPdf } from "@/lib/pdf";
import { scoreCandidateStructured, predictAcceptance, cleanCvText, extractCandidateInfo } from "@/lib/ai";
import { extractIdentityFromLinkedInProfileText } from "@/lib/linkedin-capture";
import type { ParsedRole } from "@/lib/ai";
import { applyLocationFitOverride, deriveUpdateData } from "@/lib/score-utils";
import { buildScoreCacheKey, safeParseJson } from "@/lib/utils";
import { shouldRejectAsOverseas } from "@/lib/location";
import { getJobScoringWeights } from "@/lib/scoring-config";
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
          scoringWeights: true,
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
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;
  try {
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
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;
  try {
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
  const fileHash = createHash("sha256").update(buffer).digest("hex").slice(0, 32);

  // Detect duplicate uploads — same byte-for-byte content already on this
  // candidate. Without this guard the recruiter could re-upload the same CV
  // and silently clobber any field-level extraction the previous upload made.
  // Honoured via ?force=1 in case the recruiter actually wants to re-trigger
  // scoring on the same file (rare).
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";
  if (!force) {
    const existingFiles = await prisma.candidateFile.findMany({
      where: { candidateId: id },
      select: { id: true, filename: true, data: true, createdAt: true },
    });
    const duplicate = existingFiles.find((f) =>
      createHash("sha256").update(Buffer.from(f.data, "base64")).digest("hex").slice(0, 32) === fileHash
    );
    if (duplicate) {
      return NextResponse.json(
        {
          error: "duplicate",
          message: `This file is identical to an existing upload (${duplicate.filename}, ${new Date(duplicate.createdAt).toLocaleDateString()}). Re-upload with ?force=1 to override.`,
          duplicateOf: { id: duplicate.id, filename: duplicate.filename, createdAt: duplicate.createdAt },
        },
        { status: 409 }
      );
    }
  }

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
    try {
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

      // Always merge CV with existing text when both have meaningful content.
      // LinkedIn gives current-role context + headline signal; CV gives the full
      // detailed bullet history. Together they score better than either alone,
      // and a CV-only swap would lose LinkedIn's current-employer signal.
      //
      // When the combined text exceeds the 50_000-char column limit, preserve
      // the CV intact (more authoritative for full work history) and trim the
      // LinkedIn portion. Naively slicing the concatenation chops the CV in
      // half mid-sentence and the next score sees a broken last role.
      const existingText = candidate.profileText?.trim() ?? "";
      const hasLinkedInCapture = Boolean(candidate.profileCapturedAt) || candidate.source === "extension";
      const TEXT_CAP = 50_000;
      const SEP = "\n\n--- CV ---\n\n";

      const mergeWithLinkedInTrim = (linkedin: string, cv: string): string => {
        const cvSlice = cv.slice(0, TEXT_CAP);
        if (cvSlice.length === TEXT_CAP) return cvSlice; // CV alone fills the cap
        const remaining = TEXT_CAP - cvSlice.length - SEP.length;
        if (remaining <= 0) return `${SEP}${cvSlice}`.slice(-TEXT_CAP);
        return `${linkedin.slice(0, remaining)}${SEP}${cvSlice}`;
      };

      let text: string;
      if (hasLinkedInCapture && existingText.length >= 200 && cvText) {
        text = mergeWithLinkedInTrim(existingText, cvText);
      } else if (existingText && cvText && existingText !== cvText) {
        text = mergeWithLinkedInTrim(existingText, cvText);
      } else {
        text = (cvText || existingText).slice(0, TEXT_CAP);
      }

      // Field-level enrichment: pull name / headline / location out of the CV
      // and use them to fill any blanks on the candidate record. Existing
      // non-empty values are NEVER overwritten — LinkedIn-provided fields take
      // priority over CV-extracted ones, since they're usually more current.
      let extractedName = candidate.name;
      let extractedHeadline = candidate.headline;
      let extractedLocation = candidate.location;
      const directExtract = extractIdentityFromLinkedInProfileText(text);
      if (!extractedName     && directExtract.name)     extractedName = directExtract.name;
      if (!extractedHeadline && directExtract.headline) extractedHeadline = directExtract.headline;
      if (!extractedLocation && directExtract.location) extractedLocation = directExtract.location;
      try {
        const aiExtract = await extractCandidateInfo(text);
        if (!extractedName && aiExtract.name && aiExtract.name !== "Unknown" && aiExtract.name.length > 2) {
          extractedName = aiExtract.name;
        }
        if (!extractedHeadline && aiExtract.headline && aiExtract.headline.length > 2) {
          extractedHeadline = aiExtract.headline;
        }
        if (!extractedLocation && aiExtract.location && aiExtract.location.length > 2) {
          extractedLocation = aiExtract.location;
        }
      } catch {
        // AI extraction is best-effort — direct regex extraction still ran.
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
        // Only assign when the field was empty before — never clobber existing data.
        ...(candidate.name     !== extractedName     ? { name:     extractedName     } : {}),
        ...(candidate.headline !== extractedHeadline ? { headline: extractedHeadline } : {}),
        ...(candidate.location !== extractedLocation ? { location: extractedLocation } : {}),
      };

      const parsedRole = safeParseJson<ParsedRole | null>(candidate.job?.parsedRole ?? null, null);
      let scored = false;
      if (parsedRole && candidate.job) {
        try {
          const salary = (candidate.job.salaryMin || candidate.job.salaryMax)
            ? { min: candidate.job.salaryMin ?? 0, max: candidate.job.salaryMax ?? 0 }
            : null;
          // Use job-specific weights so a recruiter who tuned a particular role
          // (e.g. higher must-have weight for security clearance) sees the CV
          // re-scored with that role's tuning, not a generic org default.
          const weights = await getJobScoringWeights(candidate.job.scoringWeights, auth.orgId);
          const [rawBreakdown, acceptanceResult] = await Promise.allSettled([
            scoreCandidateStructured(text, parsedRole, salary, weights, auth.orgId),
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
              weights,
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

      // Country gate: a CV that reveals the candidate is overseas should
      // mark the row rejected if they're still in pre-decision status.
      // Recovery path: a CV that reveals them as NZ-based when they were
      // previously auto-rejected un-rejects them.
      if (candidate.job) {
        const overseas = shouldRejectAsOverseas({
          explicitLocation: extractedLocation || candidate.location,
          headline: extractedHeadline || candidate.headline,
          profileText: text,
          isRemote: candidate.job.isRemote,
        });
        if (overseas.reject && ["new", "reviewing"].includes(candidate.status)) {
          updates.status = "rejected";
        } else if (!overseas.reject && candidate.status === "rejected") {
          updates.status = "new";
        }
      }

      await prisma.candidate.update({ where: { id }, data: updates });
      return NextResponse.json({ ...created, scored }, { status: 201 });
    }
    } catch (err) {
      reportError(err, { route: "cv-upload:postprocess", candidateId: id, orgId: auth.orgId });
      return NextResponse.json({
        ...created,
        scored: false,
        processingError: "CV uploaded, but RecruitMe could not extract or score it yet. The file is saved.",
      }, { status: 201 });
    }
  }

  const scored = false;
  return NextResponse.json({ ...created, scored }, { status: 201 });
  } catch (err) {
    reportError(err, { route: "files:post", candidateId: id, orgId: auth.orgId });
    return NextResponse.json({ error: "Server error — please try again" }, { status: 500 });
  }
}
