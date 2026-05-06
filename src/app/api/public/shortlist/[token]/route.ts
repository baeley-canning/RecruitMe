import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { safeParseJson } from "@/lib/utils";
import type { ParsedRole } from "@/lib/ai";
import type { ScoreBreakdown } from "@/lib/scoring";

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

  if (!token || token.length < 16) {
    return NextResponse.json({ error: "Invalid share link" }, { status: 404 });
  }

  const job = await prisma.job.findUnique({
    where: { shareToken: token },
    select: {
      id: true,
      title: true,
      company: true,
      location: true,
      parsedRole: true,
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

  const parsedRole = safeParseJson<ParsedRole | null>(job.parsedRole, null);

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
    candidates,
  });
}
