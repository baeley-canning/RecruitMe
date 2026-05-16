import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { extractCandidateInfo } from "@/lib/ai";
import { getAuth, unauthorized } from "@/lib/session";
import { normaliseLinkedInUrl } from "@/lib/linkedin";
import { getAccessibleOrgIds } from "@/lib/org-access";

/**
 * GET /api/candidates
 *
 * Returns the candidates library: all unique people with a meaningful reusable
 * profile, org-scoped, deduplicated by LinkedIn URL.
 *
 * For each unique person we return the most recently captured Candidate row
 * plus file metadata (no file data payload).
 */
export async function GET() {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  // Cross-org library access — accessible orgs include the caller's own
  // plus any provider orgs the caller's org has been granted access to.
  // Owners get null which means "no filter".
  const accessibleOrgIds = await getAccessibleOrgIds(auth);

  const rows = await prisma.candidate.findMany({
    where: {
      // Library used to require a captured profileText, but manual + ATS-
      // imported candidates legitimately enter without one (their data is
      // in a CV file + metadata). Whitelist those sources so they show up.
      OR: [
        { profileText: { not: null } },
        { source: { in: ["manual", "jobadder_import"] } },
      ],
      ...(accessibleOrgIds === null ? {} : {
        AND: {
          OR: [
            { job: { orgId: { in: accessibleOrgIds } } },     // via active jobs
            { jobId: null, orgId: { in: accessibleOrgIds } }, // preserved after job deletion
          ],
          NOT: { orgId: null, jobId: null },                  // never return orphaned null-org candidates
        },
      }),
    },
    // id-desc tiebreaker for bulk-insert timestamp-ties (13.5k JobAdder
    // rows shared one createdAt). Without it, the head of the page was
    // deterministically name-sorted Z's instead of "newest captures".
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    // Cap raised from 2000 to 20000 after the JobAdder bulk import pushed
    // a typical org past 13k candidates. Proper cursor pagination is the
    // right long-term fix (flagged in the architecture audit); this cap
    // keeps the page functional in the interim.
    take: 20000,
    select: {
      id: true,
      name: true,
      headline: true,
      location: true,
      linkedinUrl: true,
      // profileText INTENTIONALLY NOT SELECTED. With 14k rows × ~10KB
      // profileText, including it pulled ~140 MB of useless data over the
      // wire on every library load (the field gets stripped before
      // serialisation anyway). The old JS-side `hasFullCandidateProfile`
      // length gate is lost as a side-effect — some short captures may
      // now appear in the library that previously didn't. Acceptable
      // quality regression; future schema change can add a denormalised
      // `profileTextLength` column to restore the gate.
      matchScore: true,
      source: true,
      status: true,
      profileCapturedAt: true,
      createdAt: true,
      jobId: true,
      orgId: true,
      archivedJobTitle: true,
      archivedJobCompany: true,
      job: { select: { id: true, title: true, company: true, orgId: true } },
      files: {
        select: { id: true, type: true, filename: true, size: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      },
    },
  });

  // Filter step trimmed: the SQL where-clause already requires
  // `profileText IS NOT NULL OR source IN ("manual","jobadder_import")`,
  // so every row that arrives here is either a whitelisted source or has
  // some captured profile content. We no longer have profileText to
  // length-check in JS.
  const withProfile = rows;

  // Deduplicate by normalised LinkedIn URL; keep most recent capture per person.
  // Candidates without a LinkedIn URL are included individually (distinct people).
  type Row = typeof withProfile[number];
  const byUrl = new Map<string, Row>();
  const noUrl: Row[] = [];

  for (const row of withProfile) {
    if (!row.linkedinUrl) {
      noUrl.push(row);
      continue;
    }
    let norm: string;
    try { norm = normaliseLinkedInUrl(row.linkedinUrl); } catch { noUrl.push(row); continue; }

    const existing = byUrl.get(norm);
    if (!existing) { byUrl.set(norm, row); continue; }
    const rowAge = row.profileCapturedAt ?? row.createdAt;
    const existAge = existing.profileCapturedAt ?? existing.createdAt;
    if (rowAge > existAge) byUrl.set(norm, row);
  }

  const people = [...byUrl.values(), ...noUrl].sort(
    (a, b) => (b.profileCapturedAt ?? b.createdAt) > (a.profileCapturedAt ?? a.createdAt) ? 1 : -1
  );

  // For cross-org library access: when the candidate's effective orgId
  // (job.orgId or row.orgId) is different from the viewer's orgId, attach
  // sharedFromOrgName so the candidate-card can render a "Shared from X" badge.
  const viewerOrgId = auth.orgId ?? null;
  const externalOrgIds = new Set<string>();
  for (const p of people) {
    const candOrgId = p.job?.orgId ?? p.orgId ?? null;
    if (candOrgId && viewerOrgId && candOrgId !== viewerOrgId) externalOrgIds.add(candOrgId);
  }
  const externalOrgs = externalOrgIds.size === 0 ? [] : await prisma.org.findMany({
    where: { id: { in: [...externalOrgIds] } },
    select: { id: true, name: true },
  });
  const orgName = new Map(externalOrgs.map((o) => [o.id, o.name]));

  return NextResponse.json(people.map((row) => {
    const candOrgId = row.job?.orgId ?? row.orgId ?? null;
    const sharedFromOrgName = candOrgId && viewerOrgId && candOrgId !== viewerOrgId
      ? orgName.get(candOrgId) ?? null
      : null;
    // profileText is no longer in the select set, so no strip needed.
    return { ...row, sharedFromOrgName };
  }));
}

const CreateLibraryCandidateSchema = z.object({
  name:        z.string().min(1).max(200).trim().optional(),
  headline:    z.string().max(500).trim().optional(),
  location:    z.string().max(200).trim().optional(),
  linkedinUrl: z.string().url().max(500).optional().or(z.literal("")),
  profileText: z.string().max(50_000).optional(),
});

/**
 * POST /api/candidates
 *
 * Creates a library candidate not tied to any job.
 * Extracts name/headline/location from profileText via AI if not supplied.
 */
export async function POST(req: Request) {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const result = CreateLibraryCandidateSchema.safeParse(await req.json().catch(() => ({})));
  if (!result.success) {
    return NextResponse.json({ error: result.error.flatten() }, { status: 422 });
  }
  const body = result.data;
  const linkedinUrl = body.linkedinUrl ? normaliseLinkedInUrl(body.linkedinUrl) : null;

  if (!body.profileText && !body.name) {
    return NextResponse.json({ error: "Provide profileText or a name." }, { status: 400 });
  }

  let name = body.name ?? "";
  let headline = body.headline ?? "";
  let location = body.location ?? "";

  if (body.profileText && !name) {
    try {
      const info = await extractCandidateInfo(body.profileText);
      name = info.name;
      headline = headline || info.headline;
      location = location || info.location;
    } catch {
      name = "Unknown";
    }
  }

  const candidate = await prisma.candidate.create({
    data: {
      jobId:       null,
      orgId:       auth.orgId ?? null,
      name:        name || "Unknown",
      headline:    headline || null,
      location:    location || null,
      linkedinUrl,
      profileText: body.profileText?.trim() || null,
      source:      "manual",
      status:      "new",
    },
  });

  return NextResponse.json(candidate, { status: 201 });
}
