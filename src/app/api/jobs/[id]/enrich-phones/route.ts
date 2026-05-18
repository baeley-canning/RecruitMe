/**
 * Bulk Firmable phone enrichment for every candidate on a job.
 *
 * Recruiter-triggered: clicking the "Enrich phones" button on a job page
 * POSTs here and the route walks the job's candidates, calling Firmable for
 * any that don't have a phone yet (or, with `force: true`, all of them).
 *
 * The 90-day refresh-window check + the "already has phone" skip live in
 * enrichCandidate itself, so a recruiter who clicks the button twice in
 * quick succession only burns credits the first time.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";
import { isFirmableConfigured } from "@/lib/firmable";
import { enrichCandidatesBulk } from "@/lib/firmable-enrich";
import { reportError } from "@/lib/error-reporting";

const BodySchema = z.object({
  force: z.boolean().optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;

  try {
    const { job, error } = await requireJobAccess(id, auth);
    if (error || !job) return error;

    if (!isFirmableConfigured()) {
      return NextResponse.json(
        { error: "Phone enrichment is not configured. Set FIRMABLE_API_KEY in the Railway environment to enable it." },
        { status: 503 },
      );
    }

    const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });
    }
    const force = parsed.data.force ?? false;

    const candidates = await prisma.candidate.findMany({
      where: {
        jobId: id,
        // Skip rows without a LinkedIn URL — Firmable needs one to look up.
        // The synthetic "library:<id>" URLs we generate for orphan library
        // imports won't match anything in Firmable so we filter them too.
        linkedinUrl: { not: null },
        NOT: { linkedinUrl: { startsWith: "library:" } },
        // Don't re-enrich rows that already have a phone unless force=true.
        ...(force ? {} : { phone: null }),
      },
      select: { id: true },
    });

    if (candidates.length === 0) {
      return NextResponse.json({
        count: 0,
        enriched: 0,
        message: force
          ? "No candidates with a LinkedIn URL on this job."
          : "All candidates on this job already have a phone. Re-run with force=true to refresh.",
      });
    }

    const outcomes = await enrichCandidatesBulk(
      candidates.map((c) => c.id),
      { force, concurrency: 5 },
    );

    const enriched = outcomes.filter((o) => o.status === "enriched").length;
    const noMatch  = outcomes.filter((o) => o.status === "no_match").length;
    const skipped  = outcomes.filter((o) => o.status.startsWith("skipped")).length;
    const errors   = outcomes.filter((o) => o.status === "error").length;

    return NextResponse.json({
      count: outcomes.length,
      enriched,
      noMatch,
      skipped,
      errors,
      message: `Enriched ${enriched} of ${outcomes.length} candidates.${noMatch > 0 ? ` ${noMatch} not found in Firmable.` : ""}${errors > 0 ? ` ${errors} errored.` : ""}`,
    });
  } catch (err) {
    reportError(err, { route: "enrich-phones", jobId: id, orgId: auth.orgId });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Bulk enrichment failed" },
      { status: 500 },
    );
  }
}
