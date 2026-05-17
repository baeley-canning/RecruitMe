import { extensionCorsHeaders } from "@/lib/extension-cors";
import { NextResponse } from "next/server";
import { z } from "zod";
import { applyAiEnrichmentInBackground, importCapturedLinkedInProfileFast } from "@/lib/linkedin-capture";
import { isLinkedInProfileUrl } from "@/lib/linkedin";
import { prisma } from "@/lib/db";
import { verifyExtensionAuth } from "@/lib/session";
import { checkRateLimit, recordUsage } from "@/lib/usage";

// Stage 1 (importCapturedLinkedInProfileFast) is synchronous and bounded —
// but the extension can post a 100KB profile + captureMeta and Firmable
// pre-checks add a few hundred ms. 60s comfortably covers any single capture.
export const maxDuration = 60;

// EXTENSION_CORS headers are computed per-request to restrict to extension origins

const BodySchema = z.object({
  jobId: z.string().min(1),
  linkedinUrl: z.string().url().max(500).refine(isLinkedInProfileUrl, {
    message: "linkedinUrl must be a linkedin.com/in/<slug> URL",
  }),
  profileText: z.string().min(100).max(100_000),
  // Extension-emitted proof that the deep pages were actually fetched and how
  // each one merged. Opaque to the API; persisted on the candidate row and
  // surfaced as-is in the UI so a recruiter can see "experience pulled from
  // deep page (1240 chars), skills deep fetch was redirected away" etc.
  captureMeta: z.unknown().optional(),
});

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: extensionCorsHeaders(req) });
}

export async function POST(req: Request) {
  const auth = await verifyExtensionAuth(req);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: extensionCorsHeaders(req) });

  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422, headers: extensionCorsHeaders(req) });
  }

  const job = await prisma.job.findUnique({ where: { id: parsed.data.jobId } });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404, headers: extensionCorsHeaders(req) });
  if (!auth.isOwner && job.orgId !== auth.orgId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: extensionCorsHeaders(req) });
  }

  // Per-org rate limit. Without this, a compromised extension credential
  // can trigger unbounded scoring jobs (each consuming Claude tokens).
  const rateCheck = await checkRateLimit(auth.orgId, "capture");
  if (!rateCheck.allowed) {
    return NextResponse.json({ error: "Rate limit reached" }, { status: 429, headers: extensionCorsHeaders(req) });
  }

  try {
    // Stage 1 — sync persist. The bubble's "Add to {job}" UX shows
    // "✓ Added to {job}" the moment this returns; scoring lands later.
    const { candidate, identity } = await importCapturedLinkedInProfileFast(parsed.data);
    void recordUsage(auth.orgId, auth.userId, "capture", { jobId: parsed.data.jobId, source: "extension_import" });
    // Stage 2 — fire-and-forget AI scoring. Logged on failure but never
    // blocks the response.
    applyAiEnrichmentInBackground(candidate.id, identity).catch((err) => {
      console.error("[extension/import] background scoring crashed:", err);
    });
    return NextResponse.json(candidate, { headers: extensionCorsHeaders(req) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to import captured profile" },
      { status: 500, headers: extensionCorsHeaders(req) }
    );
  }
}
