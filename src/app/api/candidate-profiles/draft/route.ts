import { NextResponse } from "next/server";
import { draftCandidateProfileFromSource } from "@/lib/ai";
import { getAuth, unauthorized } from "@/lib/session";

export async function POST(req: Request) {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const body = await req.json().catch(() => null) as { sourceText?: unknown } | null;
  const sourceText = typeof body?.sourceText === "string" ? body.sourceText.trim() : "";

  if (sourceText.length < 200) {
    return NextResponse.json({ error: "Add at least 200 characters of CV, LinkedIn, notes, or profile text before drafting." }, { status: 400 });
  }

  const draft = await draftCandidateProfileFromSource(sourceText);
  return NextResponse.json({ draft });
}
