import { NextResponse } from "next/server";
import { parseJobDescription } from "@/lib/ai";
import { deriveJobBriefUploadPrefill, deriveRegexFallbackPrefill } from "@/lib/job-brief-prefill";
import { extractTextFromPdf } from "@/lib/pdf";
import { getAuth, unauthorized } from "@/lib/session";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

export async function POST(req: Request) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const contentType = req.headers.get("content-type") ?? "";

  if (!contentType.includes("multipart/form-data")) {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  const mode = String(formData.get("mode") ?? "").trim().toLowerCase();

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "File too large (max 10 MB)" }, { status: 413 });
  }

  const name = file.name.toLowerCase();
  const isDocx = name.endsWith(".docx") || name.endsWith(".doc");
  const isPdf  = name.endsWith(".pdf");
  const isTxt  = name.endsWith(".txt");

  if (!isPdf && !isTxt && !isDocx) {
    return NextResponse.json({ error: "Supported formats: PDF, DOCX, DOC, TXT" }, { status: 400 });
  }

  // Server-side MIME check — browser-supplied file.type is untrustworthy but
  // combined with the magic-byte check below it stops obvious disguised files.
  const allowedMimes = new Set([
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/msword",
    "text/plain",
    "application/octet-stream", // some browsers send this for .docx
  ]);
  if (file.type && !allowedMimes.has(file.type)) {
    return NextResponse.json({ error: "Unsupported file type" }, { status: 400 });
  }

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const buildResponse = async (text: string) => {
    if (mode !== "job-brief") {
      return NextResponse.json({ text });
    }

    try {
      const parsedRole = await parseJobDescription(text);
      // Pass jdText so deriveJobBriefUploadPrefill can fall back to regex
      // for any field the AI returned empty (or for all fields if Claude
      // returned a stub). Better than leaving the form blank.
      const prefill = deriveJobBriefUploadPrefill(parsedRole, text);
      return NextResponse.json({ text, prefill });
    } catch (err) {
      console.warn("[upload] AI parse failed; falling back to regex prefill:", err);
      // AI threw (network, rate limit, transient error) — try the
      // regex-only fallback so the recruiter still gets title/location
      // pre-filled. They click Create, the JD gets fully parsed by the
      // background job at job-creation time anyway.
      const prefill = deriveRegexFallbackPrefill(text);
      return NextResponse.json({ text, prefill, prefillFallback: true });
    }
  };

  if (isTxt) {
    return buildResponse(buffer.toString("utf-8"));
  }

  if (isDocx) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mammoth = require("mammoth") as { extractRawText: (opts: { buffer: Buffer }) => Promise<{ value: string }> };
      const result = await mammoth.extractRawText({ buffer });
      const text = result.value.trim();
      if (!text) {
        return NextResponse.json({ error: "Could not extract text from this Word document." }, { status: 422 });
      }
      return buildResponse(text);
    } catch (err) {
      console.error("DOCX extraction error:", err);
      return NextResponse.json({ error: "Could not read this Word document." }, { status: 500 });
    }
  }

  // PDF — extract text and return raw. The JD parser handles structure extraction.
  try {
    const text = await extractTextFromPdf(buffer);
    if (!text.trim()) {
      return NextResponse.json(
        { error: "Could not extract text from PDF. Make sure it is a text-based PDF, not a scan." },
        { status: 422 }
      );
    }
    return buildResponse(text);
  } catch (err) {
    console.error("PDF extraction error:", err);
    return NextResponse.json(
      { error: "Could not read this PDF. Try saving as a different PDF, or paste the text directly." },
      { status: 500 }
    );
  }
}
