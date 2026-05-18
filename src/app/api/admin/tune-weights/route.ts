import { NextResponse } from "next/server";
import { getAuth, unauthorized } from "@/lib/session";
import { analyseCorrectionPatterns } from "@/lib/feedback-loop";

export async function GET() {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  if (!auth.orgId) return NextResponse.json({ error: "No organisation" }, { status: 400 });

  const result = await analyseCorrectionPatterns(auth.orgId);
  return NextResponse.json(result);
}
