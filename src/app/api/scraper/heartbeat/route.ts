/**
 * POST /api/scraper/heartbeat — the worker checks in each poll cycle (Phase I2).
 *
 * Upserts ONE row per worker box (keyed by a stable workerId) so /api/health and
 * the box-dashboard can see real liveness even when the queue is idle, instead of
 * only inferring it from stale ScrapeJob rows. Auth: the existing scraper auth
 * (SCRAPER_SECRET or a bound token); no orgId — single-org box. Fire-and-forget
 * from the worker, so failures here never block the poll loop.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { authenticateScraper } from "@/lib/scraper-auth";
import { isScraperEnabled } from "@/lib/feature-flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  workerId: z.string().min(1).max(120),
  lastPollAt: z.string().datetime().optional().nullable(),
  jobsOk: z.number().int().min(0).optional(),
  jobsFailed: z.number().int().min(0).optional(),
  pollErrors: z.number().int().min(0).optional(),
  detail: z.string().max(500).optional().nullable(),
});

export async function POST(req: Request) {
  if (!isScraperEnabled()) {
    return NextResponse.json({ error: "Scraper not enabled." }, { status: 404 });
  }
  const principal = await authenticateScraper(req);
  if (!principal) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid heartbeat payload." }, { status: 422 });
  }
  const b = parsed.data;
  const fields = {
    lastPollAt: b.lastPollAt ? new Date(b.lastPollAt) : undefined,
    jobsOk: b.jobsOk,
    jobsFailed: b.jobsFailed,
    pollErrors: b.pollErrors,
    detail: b.detail ?? undefined,
  };
  await prisma.scraperHeartbeat.upsert({
    where: { workerId: b.workerId },
    create: { workerId: b.workerId, ...fields },
    update: fields,
  });
  return NextResponse.json({ ok: true });
}
