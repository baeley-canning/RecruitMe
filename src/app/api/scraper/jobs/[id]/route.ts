/**
 * Scraper job result submission — Railway side.
 *
 * ── FOR AI HANDOFF ────────────────────────────────────────────────────────────
 * Called by scraper-worker after completing or failing a job.
 *
 * PATCH — submit result or report failure.
 *   Body: { status: "done" | "error", result?: ScrapeJobResult, error?: string, workerId?: string }
 *
 * On "done" + profileText present + candidateId in job input:
 *   → updates Candidate.profileText + triggers background AI scoring
 *   → same pipeline as extension import (src/app/api/extension/fetch-session/complete/route.ts)
 *
 * Authentication: same Bearer API key as GET /api/scraper/jobs
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveApiKey } from "@/lib/api-keys";
import { completeScrapeJob, failScrapeJob } from "@/lib/scrape-queue";

const PatchSchema = z.discriminatedUnion("status", [
  z.object({
    status:   z.literal("done"),
    workerId: z.string().optional(),
    result: z.object({
      profileText: z.string().optional(),
      name:        z.string().optional(),
      headline:    z.string().optional(),
      location:    z.string().optional(),
      candidates:  z.array(z.object({
        url:       z.string(),
        name:      z.string(),
        headline:  z.string(),
        location:  z.string().optional(),
      })).optional(),
    }),
  }),
  z.object({
    status:   z.literal("error"),
    workerId: z.string().optional(),
    error:    z.string(),
  }),
]);

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
) {
  const authHeader = req.headers.get("authorization");
  const rawKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  if (!rawKey) {
    return NextResponse.json({ error: "Missing Authorization header" }, { status: 401 });
  }
  const orgId = await resolveApiKey(rawKey);
  if (!orgId) {
    return NextResponse.json({ error: "Invalid or revoked API key" }, { status: 401 });
  }

  const parsed = PatchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", issues: parsed.error.issues }, { status: 400 });
  }

  const body = parsed.data;

  if (body.status === "done") {
    await completeScrapeJob(params.id, body.result);
  } else {
    await failScrapeJob(params.id, body.error);
  }

  return NextResponse.json({ ok: true });
}
