import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { safeParseJson } from "@/lib/utils";
import type { ParsedRole } from "@/lib/ai";
import type { ScoreBreakdown } from "@/lib/scoring";
import { getWhiteLabelConfig, type WhiteLabelConfig } from "@/lib/white-label";
import { isWhiteLabelEnabled } from "@/lib/feature-flags";

// Public, unauthenticated read-only shortlist endpoint.
// Returns ONLY shortlisted candidates with safe-to-share fields.
// No auth, no PII beyond what the recruiter has explicitly chosen to share
// (name, headline, location, match score + summary). LinkedIn URLs are
// included so the client can verify candidates independently. Notes,
// internal status history, and screening data are NEVER returned.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  // 32-byte base64url tokens are exactly 43 chars (no padding). Reject anything
  // that doesn't look like a valid token rather than touching the DB on garbage.
  if (!token || !/^[A-Za-z0-9_-]{40,64}$/.test(token)) {
    return NextResponse.json({ error: "Invalid share link" }, { status: 404 });
  }

  const job = await prisma.job.findUnique({
    where: { shareToken: token },
    select: {
      id: true,
      orgId: true,
      title: true,
      company: true,
      location: true,
      parsedRole: true,
      shareTokenExpiresAt: true,
      candidates: {
        where: { status: "shortlisted" },
        orderBy: { matchScore: "desc" },
        select: {
          id: true,
          name: true,
          headline: true,
          location: true,
          linkedinUrl: true,
          matchScore: true,
          scoreBreakdown: true,
          // Deliberately omitted: notes, status history, screening, interview,
          // acceptance score, contact details, internal flags.
        },
      },
    },
  });

  if (!job) {
    return NextResponse.json({ error: "Shortlist not found" }, { status: 404 });
  }

  // Expired tokens 404 like missing ones — don't tell the caller the share
  // ever existed. Recruiter can rotate to issue a fresh URL.
  if (job.shareTokenExpiresAt && job.shareTokenExpiresAt.getTime() < Date.now()) {
    return NextResponse.json({ error: "Shortlist not found" }, { status: 404 });
  }

  const parsedRole = safeParseJson<ParsedRole | null>(job.parsedRole, null);

  // White-label branding for this org (client-facing surface — the most
  // important place to honour an agency's brand). Gated on the flag; empty when
  // off so the page falls back to the RecruitMe default.
  const brand: WhiteLabelConfig = (isWhiteLabelEnabled() && job.orgId)
    ? await getWhiteLabelConfig(job.orgId).catch(() => ({}))
    : {};

  // Strip score breakdowns down to the recruiter-summary + reasons; the
  // client doesn't need raw category weights.
  const candidates = job.candidates.map((c) => {
    const bd = safeParseJson<ScoreBreakdown | null>(c.scoreBreakdown, null);
    return {
      id: c.id,
      name: c.name,
      headline: c.headline,
      location: c.location,
      linkedinUrl: c.linkedinUrl,
      matchScore: c.matchScore,
      summary: bd?.recruiter_summary ?? null,
      strengths: bd?.reasons_for ?? [],
      gaps: bd?.reasons_against ?? [],
    };
  });

  return NextResponse.json({
    job: {
      title: job.title,
      company: job.company,
      location: job.location,
      mustHaves: parsedRole?.must_haves ?? [],
    },
    brand: {
      brandName: brand.brandName ?? null,
      logoUrl: brand.logoUrl ?? null,
      footerText: brand.footerText ?? null,
    },
    candidates,
  });
}
