/**
 * Hunt planning for the browser companion.
 *
 * The extension runs inside the recruiter's own logged-in LinkedIn session. It
 * is deliberately DUMB: it can open tabs and read the DOM, and nothing else. It
 * asks this endpoint what to search for, and later asks /api/hunt/cards what the
 * results are worth. Every judgement — how to phrase the query, what a good
 * candidate looks like, what it costs — stays on the server, where the scoring
 * rubric, the spend cap and org isolation live and where a customer cannot edit
 * it.
 *
 * The plan deliberately contains TITLES ONLY for the live query. LinkedIn's
 * basic people-search returns "No results found" for `(titles) AND (skills)`:
 * verified on the box 2026-06-15 (a 5-title OR-group returned ~33 results, the
 * same group AND a skill group returned 0) and again live 2026-08-12, when a
 * skill-gated boolean completed cleanly and harvested ZERO cards. Skills filter
 * afterwards, in scoring — they must never gate recall.
 *
 * NOTE ON LOCATION: the plan carries a location STRING for display and for
 * server-side filtering, never a LinkedIn geoUrn. The geoUrn filter was removed
 * from the scraper on 2026-06-15 because it returned "No results found" for
 * every query — a no-geo `developer` search returned 36 NZ profiles, the same
 * search with geoUrn=["103844754"] returned 0.
 */
import { extensionCorsHeaders } from "@/lib/extension-cors";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { verifyExtensionAuth } from "@/lib/session";
import { checkRateLimit, recordUsage } from "@/lib/usage";
import { reportError } from "@/lib/error-reporting";
import { linkedinTitleQuery } from "@/lib/boolean-query/emit";
import { buildHuntQueries } from "@/lib/talent-search/hunt-queries";
import type { ParsedRole } from "@/lib/ai";

export const maxDuration = 30;

const BodySchema = z.object({
  jobId: z.string().min(1),
  /** Optional override; falls back to the job's own location. */
  location: z.string().max(120).optional(),
});

function safeParseRole(raw: string | null): ParsedRole | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ParsedRole;
  } catch {
    return null;
  }
}

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: extensionCorsHeaders(req) });
}

export async function POST(req: Request) {
  const auth = await verifyExtensionAuth(req);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: extensionCorsHeaders(req) });
  }

  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422, headers: extensionCorsHeaders(req) });
  }

  const job = await prisma.job.findUnique({ where: { id: parsed.data.jobId } });
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404, headers: extensionCorsHeaders(req) });
  }
  // Org isolation: a token for one org must never plan a hunt against another's
  // job. Owners are the only principals allowed to cross orgs.
  if (!auth.isOwner && job.orgId !== auth.orgId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: extensionCorsHeaders(req) });
  }

  // A hunt IS a search, so it draws on the same per-org budget. Sharing the
  // bucket is deliberate: a recruiter who has burned their hourly searches in
  // the app should not get a fresh allowance by switching to the extension.
  const limit = await checkRateLimit(auth.orgId, "search");
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Rate limit reached", retryAfterMs: limit.retryAfterMs },
      { status: 429, headers: extensionCorsHeaders(req) },
    );
  }

  const role = safeParseRole(job.parsedRole);
  if (!role) {
    // The job has never been analysed. Planning a hunt off an unparsed JD would
    // mean an AI call per hunt; instead say so plainly and let the recruiter
    // press Re-analyse once, which is already a button in the app.
    return NextResponse.json(
      { error: "This job has not been analysed yet — open it in RecruitMe and press Re-analyse first." },
      { status: 409, headers: extensionCorsHeaders(req) },
    );
  }

  const titles = [role.title, ...(role.synonym_titles ?? [])].filter(Boolean) as string[];
  // A PORTFOLIO of short searches, not one boolean — each a different angle on
  // the role. Modelled on a transcript of Claude-in-Chrome sourcing a real
  // "Observability and Networks Manager" role, which ran four separate searches
  // ("Network Operations Manager", "Observability Manager",
  // "Infrastructure Manager AIOps", "Network Manager Observability") rather than
  // one query. One query finds one slice of a market.
  const queries = buildHuntQueries(role);
  // Kept for callers that want the strict boolean (the box scraper's shape).
  const booleanQuery = linkedinTitleQuery(titles);
  if (queries.length === 0) {
    return NextResponse.json(
      { error: "This job has no usable job titles to search on." },
      { status: 409, headers: extensionCorsHeaders(req) },
    );
  }

  const location = (parsed.data.location ?? job.location ?? "").trim() || null;

  try {
    await recordUsage(auth.orgId, auth.userId, "search", { source: "extension-hunt", jobId: job.id });
  } catch (err) {
    reportError(err, { route: "hunt/plan", orgId: auth.orgId ?? undefined });
  }

  return NextResponse.json(
    {
      jobId: job.id,
      jobTitle: job.title,
      company: job.company,
      location,
      // What the extension types into LinkedIn's own search box, one angle at a
      // time. Short bare keywords, no quotes or booleans — that is what
      // LinkedIn's basic people-search rewards.
      queries,
      // The strict quoted OR-group, for callers that want the box scraper's shape.
      booleanQuery,
      // Shown to the recruiter before anything opens, so the plan is approved
      // rather than discovered.
      titles: titles.slice(0, 6),
      mustHaves: (role.must_haves ?? []).slice(0, 12),
      seniority: role.seniority_band ?? null,
      // Hard ceilings the extension must respect. Sent from the server so they
      // can be tightened centrally without shipping a new extension.
      limits: { maxPages: 2, maxProfiles: 10, minMsBetweenProfiles: 4000 },
    },
    { headers: extensionCorsHeaders(req) },
  );
}
