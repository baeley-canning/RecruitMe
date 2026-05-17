import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAuth, requireCandidateAccess, unauthorized } from "@/lib/session";
import { safeParseJson } from "@/lib/utils";
import type { ParsedRole } from "@/lib/ai";
import { bumpCorrectionsVersion } from "@/lib/recruiter-memory";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; candidateId: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id, candidateId } = await params;

  const { job, candidate, error } = await requireCandidateAccess(id, candidateId, auth);
  if (error || !job || !candidate) return error;

  const body = await req.json().catch(() => null) as {
    recruiterScore?: number;
    reason?: string;
  } | null;

  if (!body || typeof body.recruiterScore !== "number") {
    return NextResponse.json({ error: "recruiterScore (0-100) is required" }, { status: 400 });
  }
  const recruiterScore = Math.max(0, Math.min(100, Math.round(body.recruiterScore)));

  // Capture the role title at correction time so future scoring runs can
  // match by role similarity (matches recruiter-memory's title-similarity logic).
  const parsedRole = safeParseJson<ParsedRole | null>(job.parsedRole, null);
  const roleTitle = parsedRole?.title ?? null;

  const correction = await prisma.scoreCorrection.create({
    data: {
      candidateId,
      jobId: id,
      orgId: candidate.orgId ?? job.orgId ?? null,
      originalScore: candidate.matchScore ?? 0,
      recruiterScore,
      reason: body.reason?.toString().trim().slice(0, 500) || null,
      roleTitle,
    },
  });

  // Audit SC4: bump the per-org corrections-version so the next score request
  // for any candidate in this org rebuilds a fresh cache key and bypasses the
  // stale cached score. Without this, a recruiter saves a correction and the
  // recruiter-memory context that the correction adds gets silently ignored on
  // subsequent re-pulls of cached candidates.
  const bumpOrgId = candidate.orgId ?? job.orgId ?? auth.orgId ?? null;
  if (bumpOrgId) {
    // Fire-and-forget — a DB blip here shouldn't fail the correction save.
    // Worst case the cache stays valid for one more re-score; the next
    // correction (or a 60s TTL on the in-process cache) recovers.
    void bumpCorrectionsVersion(bumpOrgId);
  }

  return NextResponse.json(correction);
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; candidateId: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id, candidateId } = await params;

  const { error } = await requireCandidateAccess(id, candidateId, auth);
  if (error) return error;

  const corrections = await prisma.scoreCorrection.findMany({
    where: { candidateId },
    orderBy: { createdAt: "desc" },
    select: { id: true, originalScore: true, recruiterScore: true, reason: true, createdAt: true },
  });

  return NextResponse.json(corrections);
}
