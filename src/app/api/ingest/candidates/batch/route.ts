/**
 * POST /api/ingest/candidates/batch — headless-scraper batch ingest.
 *
 * The user's own mini-PC scraper pulls their own candidate data from
 * JobAdder / LinkedIn / SEEK and POSTs batches of profiles here. Each
 * profile lands in the LIBRARY (jobId: null) with source "scraper", scoped
 * to the token's org. Provenance is carried by which URL field is set.
 *
 * Auth: bearer token (Authorization: Bearer <token>) via verifyScraperAuth.
 * Mint a token with `node scripts/create-scraper-token.mjs <label> [orgId]`.
 *
 * Dedup (app-level): the (jobId, linkedinUrl) unique constraint does NOT
 * dedup library rows because Postgres treats NULL jobId as distinct. So for
 * each profile we compute an identity key — normalised linkedinUrl, else
 * jobAdderUrl, else seekUrl — and look up an existing library Candidate in
 * the same org whose corresponding URL field matches. Found → update (fill
 * missing fields only, never clobber a populated profileText with null).
 * Not found → create. A profile with no usable URL key is skipped — we won't
 * create un-dedupable library rows.
 *
 * Cost-discipline: NO AI scoring fires at ingest. Profiles land UNSCORED;
 * the recruiter scores on demand later (same as the talent-pool import).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { verifyScraperAuth, unauthorized } from "@/lib/session";
import { reportError } from "@/lib/error-reporting";
import { isLinkedInProfileUrl, normaliseLinkedInUrl } from "@/lib/linkedin";
import { isSeekProfileUrl, normaliseSeekUrl } from "@/lib/seek";
import { normaliseJobAdderUrl, identityMergeKey } from "@/lib/identity-merge";

const ProfileSchema = z.object({
  name: z.string().min(1).max(500),
  headline: z.string().nullable(),
  location: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  jobAdderUrl: z.string().nullable(),
  seekUrl: z.string().nullable(),
  // Full profile / CV text. Allowed to be null (URL-only capture), but if
  // present it must be substantial enough to be worth scoring later.
  profileText: z.string().min(50).nullable(),
  externalId: z.string().nullable(),
  source: z.enum(["linkedin", "jobadder", "seek"]).optional(),
});

const BodySchema = z.object({
  profiles: z.array(ProfileSchema).min(1).max(200),
});

type Profile = z.infer<typeof ProfileSchema>;

interface IngestOutcome {
  index: number;
  status: "created" | "updated" | "skipped" | "failed";
  candidateId?: string;
  reason?: string;
}

/**
 * Validate each URL with its profile-URL matcher and normalise it. A URL
 * that's present but invalid is DROPPED (returned null) — we don't fail the
 * whole row over one bad link. JobAdder has no strict format check (tenant
 * subdomains vary), so we only require it be a non-empty http(s) URL.
 */
function cleanUrls(p: Profile): {
  linkedinUrl: string | null;
  jobAdderUrl: string | null;
  seekUrl: string | null;
} {
  const linkedinUrl =
    p.linkedinUrl && isLinkedInProfileUrl(p.linkedinUrl)
      ? normaliseLinkedInUrl(p.linkedinUrl)
      : null;
  const seekUrl =
    p.seekUrl && isSeekProfileUrl(p.seekUrl) ? normaliseSeekUrl(p.seekUrl) : null;
  const jobAdderUrl =
    p.jobAdderUrl && /^https?:\/\//i.test(p.jobAdderUrl.trim())
      ? normaliseJobAdderUrl(p.jobAdderUrl)
      : null;
  return { linkedinUrl, jobAdderUrl, seekUrl };
}

export async function POST(req: Request) {
  const auth = await verifyScraperAuth(req);
  if (!auth) return unauthorized();

  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });
  }
  const { profiles } = parsed.data;

  const outcomes: IngestOutcome[] = [];

  for (let index = 0; index < profiles.length; index++) {
    try {
      outcomes.push(await ingestOne(profiles[index], index, auth.orgId));
    } catch (err) {
      reportError(err, { route: "ingest/candidates/batch", orgId: auth.orgId, index });
      outcomes.push({
        index,
        status: "failed",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const counts = {
    created: outcomes.filter((o) => o.status === "created").length,
    updated: outcomes.filter((o) => o.status === "updated").length,
    skipped: outcomes.filter((o) => o.status === "skipped").length,
    failed: outcomes.filter((o) => o.status === "failed").length,
    total: outcomes.length,
  };

  return NextResponse.json({ outcomes, counts });
}

/**
 * Land one scraped profile in the library. Returns the outcome the route
 * aggregates. May throw (DB errors) — the caller converts to "failed".
 */
async function ingestOne(
  p: Profile,
  index: number,
  orgId: string | null,
): Promise<IngestOutcome> {
  const { linkedinUrl, jobAdderUrl, seekUrl } = cleanUrls(p);

  // Identity key: normalised linkedinUrl > jobAdderUrl > seekUrl. Built from
  // the CLEANED urls so invalid ones never become a key.
  const key = identityMergeKey({ linkedinUrl, jobAdderUrl, seekUrl });

  // No usable URL key → un-dedupable library row. We only dedup on URL
  // fields, so an externalId on its own is NOT an identity axis — skip
  // rather than create a row we can never match against on re-ingest.
  if (!key) {
    return { index, status: "skipped", reason: "no_identity_key" };
  }

  // Find an existing library row (this org, jobId null) by the populated URL
  // field matching our key.
  const urlWhere =
    key.kind === "linkedinUrl"
      ? { linkedinUrl: key.value }
      : key.kind === "jobAdderUrl"
        ? { jobAdderUrl: key.value }
        : { seekUrl: key.value };

  const existing = await prisma.candidate.findFirst({
    where: { orgId, jobId: null, ...urlWhere },
    select: {
      id: true,
      headline: true,
      location: true,
      linkedinUrl: true,
      jobAdderUrl: true,
      seekUrl: true,
      profileText: true,
    },
  });

  if (existing) {
    // Fill-only update: populate fields we have that are currently empty.
    // Never clobber a populated profileText with null.
    const data: Record<string, unknown> = { source: "scraper" };
    if (!existing.headline && p.headline) data.headline = p.headline;
    if (!existing.location && p.location) data.location = p.location;
    if (!existing.linkedinUrl && linkedinUrl) data.linkedinUrl = linkedinUrl;
    if (!existing.jobAdderUrl && jobAdderUrl) data.jobAdderUrl = jobAdderUrl;
    if (!existing.seekUrl && seekUrl) data.seekUrl = seekUrl;
    if (!existing.profileText && p.profileText) data.profileText = p.profileText;

    const updated = await prisma.candidate.update({
      where: { id: existing.id },
      data,
    });
    return { index, status: "updated", candidateId: updated.id };
  }

  const created = await prisma.candidate.create({
    data: {
      jobId: null,
      orgId,
      name: p.name,
      headline: p.headline,
      location: p.location,
      linkedinUrl,
      jobAdderUrl,
      seekUrl,
      profileText: p.profileText,
      source: "scraper",
      status: "new",
    },
  });
  return { index, status: "created", candidateId: created.id };
}
