/**
 * GET  /api/scraper/jobs  — worker polls for pending scrape jobs
 * POST /api/scraper/jobs  — enqueue a new scrape job
 *
 * Auth: x-scraper-secret header (timing-safe compare against SCRAPER_SECRET env).
 * The scraper worker uses this key on every request.
 *
 * GET: claims up to 5 pending jobs atomically (status pending → processing)
 * and returns them. The worker processes each and POSTes results to
 * PATCH /api/scraper/jobs/[id].
 *
 * POST: enqueues a new job. Used by admin tooling or future UI triggers.
 * Returns the created ScrapeJob row.
 */

import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { isScraperEnabled } from "@/lib/feature-flags";
import { randomUUID } from "crypto";

const CLAIM_LIMIT = 5;

// SSRF hardening: a profile job tells the worker to navigate to profileUrl, so
// the enqueue path must only accept hosts on known scraping platforms. We match
// by hostname suffix (covers www. / regional subdomains) rather than exact
// equality so existing linkedin/seek/jobadder enqueues keep working.
const ALLOWED_PROFILE_HOST_SUFFIXES = [
  "linkedin.com", // covers www.linkedin.com, *.linkedin.com
  "employer.seek.com", // au.employer.seek.com / nz.employer.seek.com
  "talentsearch.seek.com.au",
  "jobadder.com", // *.jobadder.com regional hosts
] as const;

function isAllowedProfileHost(profileUrl: string): boolean {
  let host: string;
  try {
    host = new URL(profileUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return ALLOWED_PROFILE_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

function checkScraperSecret(req: Request): boolean {
  const provided = req.headers.get("x-scraper-secret");
  const expected = process.env.SCRAPER_SECRET;
  if (!provided || !expected) return false;
  try {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export async function GET(req: Request) {
  if (!isScraperEnabled()) {
    return NextResponse.json({ error: "Scraper not enabled." }, { status: 404 });
  }
  if (!checkScraperSecret(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const url = new URL(req.url);
  const orgId = url.searchParams.get("orgId");

  // Claim pending jobs atomically: update status to processing, return them.
  const whereClause = orgId
    ? { status: "pending", orgId }
    : { status: "pending" };

  // Fetch then update — prisma doesn't support UPDATE...RETURNING in one call.
  // Phase H: priority-aware ordering. Live recruiter searches enqueue with
  // priority=100 and jump ahead of any background discovery jobs (priority=0).
  // Within the same priority bucket, FIFO by createdAt.
  const jobSelect = {
    id: true,
    orgId: true,
    platform: true,
    kind: true,
    profileUrl: true,
    searchQuery: true,
    searchRunId: true, // Phase K: worker propagates this to profile children
    priority: true, // Phase H: worker propagates this to enrichment child jobs
    retryCount: true,
  } as const;

  // Phase K fairness: claim up to CLAIM_LIMIT-1 by priority, but RESERVE one
  // slot for the oldest background (priority<100) job so a burst of live
  // searches can't fully starve flywheel discovery. If no background job
  // exists, the priority claim fills all slots as before.
  const priorityClaim = await prisma.scrapeJob.findMany({
    where: whereClause,
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    take: Math.max(1, CLAIM_LIMIT - 1),
    select: jobSelect,
  });
  const claimedIds = new Set(priorityClaim.map((j) => j.id));
  const reserved = await prisma.scrapeJob.findFirst({
    where: { ...whereClause, priority: { lt: 100 }, id: { notIn: [...claimedIds] } },
    orderBy: { createdAt: "asc" },
    select: jobSelect,
  });
  const jobs = reserved ? [...priorityClaim, reserved] : priorityClaim;

  if (jobs.length === 0) {
    return NextResponse.json({ jobs: [] });
  }

  await prisma.scrapeJob.updateMany({
    where: { id: { in: jobs.map((j) => j.id) } },
    data: { status: "processing", updatedAt: new Date() },
  });

  // Enrich search jobs with their SearchRun's location filter (stored on the
  // run, not the job) so the worker can scope SEEK to the recruiter's region
  // (e.g. "Wellington") instead of searching nation-wide.
  const runIds = [...new Set(jobs.filter((j) => j.kind === "search" && j.searchRunId).map((j) => j.searchRunId as string))];
  const locByRun = new Map<string, string | null>();
  if (runIds.length > 0) {
    const runs = await prisma.searchRun.findMany({
      where: { id: { in: runIds } },
      select: { id: true, location: true },
    });
    for (const r of runs) locByRun.set(r.id, r.location);
  }
  const enriched = jobs.map((j) => ({
    ...j,
    searchLocation: j.searchRunId ? locByRun.get(j.searchRunId) ?? null : null,
  }));

  return NextResponse.json({ jobs: enriched });
}

const PostSchema = z.object({
  orgId: z.string().min(1),
  platform: z.enum(["linkedin", "seek", "jobadder"]),
  // Optional kind discriminator. Defaults to "profile" so existing callers
  // (legacy auto-enqueue, the talent-pool import flow) work unchanged.
  kind: z.enum(["profile", "search"]).optional().default("profile"),
  // For kind="profile": the URL to scrape. For kind="search": omitted.
  profileUrl: z.string().url().max(2000).optional(),
  // For kind="search": the boolean query the worker will run. For
  // kind="profile": omitted.
  searchQuery: z.string().min(1).max(2000).optional(),
  requestedBy: z.string().optional().nullable(),
  // Phase K: links a worker-posted profile child back to its SearchRun.
  searchRunId: z.string().optional().nullable(),
  // Phase H: queue priority. 0 = background flywheel discovery (default),
  // 100 = live recruiter search. Higher jumps ahead in the GET claim ordering.
  priority: z.number().int().min(0).max(100).optional(),
}).refine(
  (d) => (d.kind === "search" ? !!d.searchQuery : !!d.profileUrl),
  { message: "profile jobs require profileUrl; search jobs require searchQuery" },
);

export async function POST(req: Request) {
  if (!isScraperEnabled()) {
    return NextResponse.json({ error: "Scraper not enabled." }, { status: 404 });
  }
  if (!checkScraperSecret(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const parsed = PostSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });
  }

  // SSRF guard: a profileUrl becomes a navigation target on the worker box, so
  // re-validate its host against the platform allowlist at enqueue time even
  // though zod already checked it parses as a URL.
  if (parsed.data.profileUrl && !isAllowedProfileHost(parsed.data.profileUrl)) {
    return NextResponse.json(
      { error: "profileUrl host is not an allowed scraping platform (linkedin.com / seek / jobadder.com)." },
      { status: 422 },
    );
  }

  // The worker harvests N profile URLs from a search and POSTs each back as a
  // child profile job carrying the parent's searchRunId. If that SearchRun has
  // since been settled-and-swept or deleted, inserting the link would violate
  // ScrapeJob_searchRunId_fkey (P2003) and 500 — silently dropping every
  // harvested candidate. The candidate still belongs in the library regardless
  // of whether the run that found them still exists, so null a dangling link
  // and ingest anyway rather than fail the whole batch.
  let searchRunId = parsed.data.searchRunId ?? null;
  if (searchRunId) {
    const run = await prisma.searchRun.findUnique({
      where: { id: searchRunId },
      select: { id: true },
    });
    if (!run) searchRunId = null;
  }

  const job = await prisma.scrapeJob.create({
    data: {
      id: randomUUID(),
      orgId: parsed.data.orgId,
      platform: parsed.data.platform,
      kind: parsed.data.kind,
      profileUrl: parsed.data.profileUrl ?? null,
      searchQuery: parsed.data.searchQuery ?? null,
      requestedBy: parsed.data.requestedBy ?? null,
      searchRunId,
      // Phase H: default to 0 (background) so existing callers are unchanged;
      // live recruiter searches pass 100 to jump the worker's claim ordering.
      priority: parsed.data.priority ?? 0,
    },
  });

  return NextResponse.json({ job }, { status: 201 });
}
