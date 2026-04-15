import { NextResponse } from "next/server";
import { extractTextFromPdf } from "@/lib/pdf";

export async function POST(req: Request) {
  const contentType = req.headers.get("content-type") ?? "";

  if (!contentType.includes("multipart/form-data")) {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const formData = await req.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  const name = file.name.toLowerCase();

  if (!name.endsWith(".pdf") && !name.endsWith(".txt")) {
    return NextResponse.json({ error: "Only PDF and TXT files are supported" }, { status: 400 });
  }

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (name.endsWith(".txt")) {
    return NextResponse.json({ text: buffer.toString("utf-8") });
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
    return NextResponse.json({ text });
  } catch (err) {
    console.error("PDF extraction error:", err);
    return NextResponse.json(
      { error: "Could not read this PDF. Try saving as a different PDF, or paste the text directly." },
      { status: 500 }
    );
  }
}
