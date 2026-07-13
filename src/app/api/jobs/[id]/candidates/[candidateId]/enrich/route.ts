/**
 * POST /api/jobs/[id]/candidates/[candidateId]/enrich — fill blanks on ONE
 * shortlisted candidate from PDL (the selective, per-candidate gap-fill).
 *
 * Deliberate spend: the caller (UI) confirms first. We look the person up on PDL
 * by their LinkedIn URL / email and FILL ONLY the fields we're missing — never
 * overwriting recruiter data, captured profileText, or CVs (see applyPdlFillOnly).
 * The write is provenance-tagged in screeningData so it's attributable + reversible.
 *
 * Auth: getAuth + requireCandidateAccess (org-scoped, same as every other
 * candidate action). Gated on PDL being configured — 409 when there's no key.
 */

import { NextResponse } from "next/server";
import { getAuth, requireCandidateAccess, unauthorized } from "@/lib/session";
import { requireCapability } from "@/lib/require-capability";
import { prisma } from "@/lib/db";
import { getServerSetting } from "@/lib/settings";
import { isLinkedInProfileUrl } from "@/lib/linkedin";
import { enrichPersonFromPdl, applyPdlFillOnly, mergePdlProvenance } from "@/lib/pdl-enrich";
import { recordUsage } from "@/lib/usage";
import { reportError } from "@/lib/error-reporting";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; candidateId: string }> },
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const denied = await requireCapability(auth, "enrich");
  if (denied) return denied;
  const { id, candidateId } = await params;

  const { candidate, error } = await requireCandidateAccess(id, candidateId, auth);
  if (error || !candidate) return error ?? NextResponse.json({ error: "Not found" }, { status: 404 });

  // PDL must be configured (env key). No key → nothing to enrich against.
  if (!(await getServerSetting("PDL_API_KEY"))) {
    return NextResponse.json({ error: "PDL is not configured." }, { status: 409 });
  }

  // Need a strong match key: a genuine LinkedIn profile URL or an email.
  const linkedinUrl = isLinkedInProfileUrl(candidate.linkedinUrl) ? candidate.linkedinUrl : null;
  const email = candidate.email ?? null;
  if (!linkedinUrl && !email) {
    return NextResponse.json(
      { error: "Nothing to match on — this candidate has no LinkedIn URL or email." },
      { status: 422 },
    );
  }

  try {
    const result = await enrichPersonFromPdl({ linkedinUrl, email });
    // null only when the key vanished between the check and the call.
    if (!result) return NextResponse.json({ error: "PDL is not configured." }, { status: 409 });

    if (!result.matched) {
      return NextResponse.json({ matched: false, filled: [] });
    }

    const { patch, filled } = applyPdlFillOnly(candidate, result);

    if (filled.length === 0) {
      // Matched, but nothing to fill — the record was already complete.
      return NextResponse.json({ matched: true, filled: [], likelihood: result.likelihood });
    }

    const capturedAt = patch.profileText ? new Date() : null;
    const screeningData = mergePdlProvenance(candidate.screeningData ?? null, filled);
    await prisma.candidate.update({
      where: { id: candidate.id },
      data: {
        ...patch,
        // Filling profileText IS a fresh capture — stamp freshness so the
        // library/confidence signals reflect it. Heuristic Fit still re-derives
        // on demand; we never stamp profileTextHash here (keeps AI re-score live).
        ...(capturedAt ? { profileCapturedAt: capturedAt } : {}),
        screeningData,
      },
    });
    // Cost attribution — a PDL enrich is a paid capture. Fire-and-forget.
    await recordUsage(auth.orgId, auth.userId, "capture", {
      action: "pdl_enrich",
      candidateId: candidate.id,
      filled,
    });

    // Return the applied fields so the UI can update the card in place without a
    // full refetch (values, not just names).
    return NextResponse.json({
      matched: true,
      filled,
      likelihood: result.likelihood,
      patch: { ...patch, ...(capturedAt ? { profileCapturedAt: capturedAt.toISOString() } : {}), screeningData },
    });
  } catch (err) {
    reportError(err, { route: "candidates:enrich", jobId: id, candidateId, orgId: auth.orgId });
    return NextResponse.json({ error: "Enrichment failed." }, { status: 500 });
  }
}
