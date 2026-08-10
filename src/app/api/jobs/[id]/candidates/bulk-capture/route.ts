import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";
import { enqueueScrapeJob } from "@/lib/scrape-queue";

// Bulk profile capture — action-plan #6, design-panel winner ("Bulk Capture v1,
// LinkedIn + JobAdder, no SEEK"). The recruiter selects a shortlist of thin
// (snippet-only) candidates and captures full profiles for all of them in one
// click. We ONLY enqueue jobs here — the single-browser scraper-worker fetches
// them sequentially at its existing safe ~30-40s/profile pace, so there are no
// new requests, no bursts, and no account-ban risk introduced by this route.
// SEEK is INCLUDED. It was excluded because "opening a SEEK profile costs a
// credit" — that premise is wrong. scrapeSeekProfile only navigates, scrolls and
// reads the DOM; it never clicks a reveal/unlock/contact or download control, and
// SEEK's metering sits behind contact details we never touch. The exclusion was
// the reason every SEEK candidate sat at profileText "" and scored ~40 on a
// ~150-char card. enqueueScrapeJob dedupes
// on (orgId, profileUrl, status in pending/processing), so a double-click can't
// double-queue.
const BodySchema = z.object({
  ids: z.array(z.string().min(1).max(40)).min(1).max(100),
});

// A candidate is "thin" (needs capture) when it has no real profile body yet —
// SEEK cards and LinkedIn search snippets. 200 chars matches the ingestion floor.
const FULL_PROFILE_CHARS = 200;

/** Enqueue a paced profile fetch for each selected thin LinkedIn/JobAdder candidate. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;
  const { job, error } = await requireJobAccess(id, auth);
  if (error || !job) return error ?? unauthorized();

  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "ids must be an array of 1–100 strings" }, { status: 422 });
  }

  const candidates = await prisma.candidate.findMany({
    where: { id: { in: parsed.data.ids }, jobId: id },
    select: { id: true, profileText: true, linkedinUrl: true, seekUrl: true, jobAdderUrl: true },
  });

  const orgId = job.orgId ?? auth.orgId;
  if (!orgId) {
    return NextResponse.json({ error: "No organisation context for this job." }, { status: 400 });
  }
  let enqueued = 0;
  let alreadyFull = 0;
  let noCapturableUrl = 0; // candidates with no linkedin/seek/jobadder URL at all
  let alreadyQueued = 0;

  for (const c of candidates) {
    if (c.profileText && c.profileText.trim().length >= FULL_PROFILE_CHARS) { alreadyFull += 1; continue; }
    // LinkedIn first (richest body), then SEEK, then JobAdder.
    const platform: "linkedin" | "seek" | "jobadder" | null =
      c.linkedinUrl ? "linkedin" : c.seekUrl ? "seek" : c.jobAdderUrl ? "jobadder" : null;
    // MUST mirror the platform precedence above — a mismatch would scrape a
    // SEEK candidate using a JobAdder URL.
    const url = c.linkedinUrl ?? c.seekUrl ?? c.jobAdderUrl ?? null;
    if (!platform || !url) { noCapturableUrl += 1; continue; }
    const created = await enqueueScrapeJob({ orgId, platform, profileUrl: url, candidateId: c.id, requestedBy: auth.userId });
    if (created) enqueued += 1; else alreadyQueued += 1; // null = dedup hit (already pending/processing)
  }

  return NextResponse.json({
    requested: parsed.data.ids.length,
    enqueued,
    alreadyFull,
    alreadyQueued,
    noCapturableUrl,
  });
}

/** Poll capture progress: how many of the given candidates now have a full profile. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;
  const { error } = await requireJobAccess(id, auth);
  if (error) return error;

  const ids = (new URL(req.url).searchParams.get("ids") ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean).slice(0, 100);
  if (ids.length === 0) return NextResponse.json({ total: 0, captured: 0, pending: 0 });

  const candidates = await prisma.candidate.findMany({
    where: { id: { in: ids }, jobId: id },
    select: { profileText: true },
  });
  const captured = candidates.filter((c) => c.profileText && c.profileText.trim().length >= FULL_PROFILE_CHARS).length;
  return NextResponse.json({ total: candidates.length, captured, pending: candidates.length - captured });
}
