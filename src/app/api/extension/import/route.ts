import { NextResponse } from "next/server";
import { z } from "zod";
import { importCapturedLinkedInProfile } from "@/lib/linkedin-capture";
import { prisma } from "@/lib/db";
import { verifyExtensionAuth } from "@/lib/session";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const BodySchema = z.object({
  jobId: z.string().min(1),
  linkedinUrl: z.string().url().max(500),
  profileText: z.string().min(100).max(100_000),
});

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(req: Request) {
  const auth = await verifyExtensionAuth(req);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: CORS });

  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422, headers: CORS });
  }

  const job = await prisma.job.findUnique({ where: { id: parsed.data.jobId } });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404, headers: CORS });
  if (!auth.isOwner && job.orgId !== auth.orgId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: CORS });
  }

  try {
    const candidate = await importCapturedLinkedInProfile(parsed.data);
    return NextResponse.json(candidate, { headers: CORS });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to import captured profile" },
      { status: 500, headers: CORS }
    );
  }
}
