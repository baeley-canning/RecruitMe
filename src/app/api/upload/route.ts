import { NextResponse } from "next/server";
import { extractTextFromPdf } from "@/lib/pdf";
import { cleanCvText } from "@/lib/ai";

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

  // TXT files — still run through Claude to clean formatting
  if (name.endsWith(".txt")) {
    const raw = buffer.toString("utf-8");
    try {
      const text = await cleanCvText(raw);
      return NextResponse.json({ text });
    } catch {
      return NextResponse.json({ text: raw });
    }
  }

  // PDF — extract then clean
  let raw: string;
  try {
    raw = await extractTextFromPdf(buffer);
    if (!raw.trim()) {
      return NextResponse.json(
        { error: "Could not extract text from PDF. Make sure it is a text-based PDF, not a scan." },
        { status: 422 }
      );
    }
  } catch (err) {
    console.error("PDF extraction error:", err);
    return NextResponse.json(
      { error: "Could not read this PDF. Try saving it as a different PDF (e.g. print to PDF from your browser), or paste the text directly." },
      { status: 500 }
    );
  }

  // Claude cleans and restructures the raw extracted text
  try {
    const text = await cleanCvText(raw);
    return NextResponse.json({ text });
  } catch (err) {
    console.error("CV clean error:", err);
    // Fall back to raw text — better than failing entirely
    return NextResponse.json({ text: raw });
  }
}
