/**
 * Scraper job queue API — Railway side.
 *
 * ── FOR AI HANDOFF ────────────────────────────────────────────────────────────
 * This route is called by the scraper-worker process (scraper-worker/src/index.ts).
 * The worker authenticates with a Bearer API key created via POST /api/v1/keys.
 *
 * GET  — worker polls for pending jobs. Atomically claims up to 5.
 * POST — internal: create a scrape job (also called from scrape-queue.ts).
 *
 * SETUP: To enable scraping, the operator must:
 *   1. Create an API key: POST /api/v1/keys { name: "scraper-worker" }
 *   2. Set SCRAPER_ENABLED=true in Railway env vars
 *   3. Copy the raw key to the Pi's .env as SCRAPER_API_KEY
 *   4. Start the scraper-worker on the Pi
 *
 * The worker then polls this route every ~15s and processes claimed jobs.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveApiKey } from "@/lib/api-keys";
import { getAuth, unauthorized } from "@/lib/session";
import {
  enqueueScrapeJob,
  claimPendingJobs,
  type ScrapeJobPlatform,
  type ScrapeJobType,
} from "@/lib/scrape-queue";

const CreateJobSchema = z.object({
  platform: z.enum(["linkedin", "seek", "jobadder"]),
  jobType:  z.enum(["profile", "search"]),
  input:    z.object({
    url:         z.string().optional(),
    query:       z.string().optional(),
    location:    z.string().optional(),
    count:       z.number().int().min(1).max(50).optional(),
    jobId:       z.string().optional(),
    candidateId: z.string().optional(),
  }),
  priority: z.number().int().min(0).max(10).optional(),
});

/** Worker polls this to claim pending jobs. */
export async function GET(req: Request) {
  // Authenticate the scraper worker via API key
  const authHeader = req.headers.get("authorization");
  const rawKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  if (!rawKey) {
    return NextResponse.json({ error: "Missing Authorization header" }, { status: 401 });
  }
  const orgId = await resolveApiKey(rawKey);
  if (!orgId) {
    return NextResponse.json({ error: "Invalid or revoked API key" }, { status: 401 });
  }

  // workerId lets us identify which Pi/node processed each job (debugging)
  const url = new URL(req.url);
  const workerId = url.searchParams.get("workerId") ?? "unknown";

  const jobs = await claimPendingJobs(orgId, workerId);
  return NextResponse.json({ jobs });
}

/** Internal: create a scrape job via session auth (called from web UI or admin). */
export async function POST(req: Request) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  if (!auth.orgId) return NextResponse.json({ error: "No organisation" }, { status: 400 });

  const parsed = CreateJobSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
  }

  const { platform, jobType, input, priority } = parsed.data;
  const jobId = await enqueueScrapeJob(
    auth.orgId,
    platform as ScrapeJobPlatform,
    jobType as ScrapeJobType,
    input,
    priority,
  );

  if (!jobId) {
    return NextResponse.json(
      { error: "Scraper not enabled. Set SCRAPER_ENABLED=true in Railway env vars." },
      { status: 503 },
    );
  }

  return NextResponse.json({ jobId }, { status: 201 });
}
