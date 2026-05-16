import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { extractCandidateInfo } from "@/lib/ai";
import { getAuth, unauthorized } from "@/lib/session";
import { normaliseLinkedInUrl } from "@/lib/linkedin";
import { getLibraryCandidates } from "@/lib/library";

/**
 * GET /api/candidates
 *
 * Returns the candidates library: all unique people with a meaningful reusable
 * profile, org-scoped (with cross-org grant expansion), deduplicated by
 * LinkedIn URL.
 *
 * The query / dedupe / shared-org enrichment lives in src/lib/library.ts so
 * the page-level SSR loader (app/candidates/page.tsx) can share the same
 * code path — they used to drift, with the page missing cross-org grants.
 */
export async function GET() {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const { candidates } = await getLibraryCandidates(auth);
  return NextResponse.json(candidates);
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
