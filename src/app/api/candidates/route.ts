import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { extractCandidateInfo } from "@/lib/ai";
import { getAuth, unauthorized } from "@/lib/session";
import { normaliseLinkedInUrl } from "@/lib/linkedin";
import { hasFullCandidateProfile } from "@/lib/candidate-profile";

/**
 * GET /api/candidates
 *
 * Returns the candidates library: all unique people with a full captured profile
 * (profileText >= 2000 chars), org-scoped, deduplicated by LinkedIn URL.
 *
 * For each unique person we return the most recently captured Candidate row
 * plus file metadata (no file data payload).
 */
export async function GET() {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const rows = await prisma.candidate.findMany({
    where: {
      profileText: { not: null },
      ...(auth.isOwner ? {} : {
        OR: [
          { job: { orgId: auth.orgId } },        // candidate still linked to a job
          { jobId: null, orgId: auth.orgId },     // candidate preserved after job deletion
        ],
      }),
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      headline: true,
      location: true,
      linkedinUrl: true,
      profileText: true,
      matchScore: true,
      source: true,
      status: true,
      profileCapturedAt: true,
      createdAt: true,
      jobId: true,
      archivedJobTitle: true,
      archivedJobCompany: true,
      job: { select: { id: true, title: true, company: true } },
      files: {
        select: { id: true, type: true, filename: true, size: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      },
    },
  });

  // Manual candidates (CV upload) bypass the 2000-char threshold — their CVs are often shorter
  const withProfile = rows.filter((row) => row.source === "manual" || hasFullCandidateProfile(row));

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

  return NextResponse.json(people.map((row) => {
    const person: Omit<typeof row, "profileText"> & { profileText?: string | null } = { ...row };
    delete person.profileText;
    return person;
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
      linkedinUrl: body.linkedinUrl?.trim() || null,
      profileText: body.profileText?.trim() || null,
      source:      "manual",
      status:      "new",
    },
  });

  return NextResponse.json(candidate, { status: 201 });
}
