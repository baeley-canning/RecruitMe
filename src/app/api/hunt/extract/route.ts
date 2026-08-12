/**
 * Turn an attached document into text for the side panel.
 *
 * A recruiter is usually holding the JD as a PDF or Word file, not as text they
 * can paste. Extraction happens here rather than in the extension because
 * pdf-parse and mammoth are Node libraries — and because the extension should
 * stay small and dumb.
 *
 * /api/upload already does this, but it authenticates by SESSION COOKIE and
 * sends no extension CORS headers, so from an extension it is always a 401 —
 * the same trap that made the job picker say "No jobs found".
 *
 * Text only comes OUT. Nothing is stored: this is a paste shortcut, not an
 * upload, so an attached JD never becomes a file we now have to look after.
 */
import { extensionCorsHeaders } from "@/lib/extension-cors";
import { NextResponse } from "next/server";
import { verifyExtensionAuth } from "@/lib/session";
import { extractTextFromPdf } from "@/lib/pdf";
import { reportError } from "@/lib/error-reporting";

export const maxDuration = 60;

/** Generous for a JD, far below anything that would strain the request. */
const MAX_BYTES = 10 * 1024 * 1024;
/** A JD is a few pages; past this the model context is the real limit anyway. */
const MAX_CHARS = 40_000;

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: extensionCorsHeaders(req) });
}

export async function POST(req: Request) {
  const auth = await verifyExtensionAuth(req);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: extensionCorsHeaders(req) });
  }

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return NextResponse.json(
      { error: "Expected multipart/form-data" },
      { status: 400, headers: extensionCorsHeaders(req) },
    );
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file === "string") {
    return NextResponse.json({ error: "No file provided" }, { status: 400, headers: extensionCorsHeaders(req) });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `That file is ${(file.size / 1024 / 1024).toFixed(1)}MB — the limit is 10MB.` },
      { status: 413, headers: extensionCorsHeaders(req) },
    );
  }

  const name = (file.name || "document").toLowerCase();
  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    let text = "";

    if (name.endsWith(".pdf") || file.type === "application/pdf") {
      text = await extractTextFromPdf(buffer);
    } else if (name.endsWith(".docx") || file.type.includes("wordprocessingml")) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mammoth = require("mammoth") as {
        extractRawText: (opts: { buffer: Buffer }) => Promise<{ value: string }>;
      };
      text = (await mammoth.extractRawText({ buffer })).value;
    } else if (name.endsWith(".doc")) {
      // Legacy binary .doc is a different format mammoth cannot read. Say so
      // plainly rather than returning the mojibake of a binary read.
      return NextResponse.json(
        { error: "Old .doc files aren't supported — save it as .docx or PDF, or paste the text." },
        { status: 415, headers: extensionCorsHeaders(req) },
      );
    } else {
      // .txt, .md, .rtf and anything else texty.
      text = buffer.toString("utf8");
    }

    text = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

    if (!text) {
      // A scanned PDF is images with no text layer. That is a real, common case
      // and it must not look like a silent failure.
      return NextResponse.json(
        {
          error:
            "No text could be read from that file. If it's a scan or an image-only PDF, " +
            "there is no text layer to extract — paste the text instead.",
        },
        { status: 422, headers: extensionCorsHeaders(req) },
      );
    }

    const truncated = text.length > MAX_CHARS;
    return NextResponse.json(
      {
        filename: file.name || "document",
        chars: text.length,
        truncated,
        text: truncated ? text.slice(0, MAX_CHARS) : text,
      },
      { headers: extensionCorsHeaders(req) },
    );
  } catch (err) {
    reportError(err, { route: "hunt/extract", orgId: auth.orgId ?? undefined });
    return NextResponse.json(
      { error: `Could not read that file: ${err instanceof Error ? err.message : "unknown error"}` },
      { status: 422, headers: extensionCorsHeaders(req) },
    );
  }
}
