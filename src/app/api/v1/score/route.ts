/**
 * Score-as-a-Service API — P6-2
 *
 * POST /api/v1/score
 *
 * Authentication: Bearer token in Authorization header (API key from /api/v1/keys).
 * Plan gate: Agency plan only (hasApiAccess).
 *
 * Request body:
 *   profileText    string  — candidate CV / profile text (required)
 *   jobDescription string  — raw JD text to parse (required unless parsedRole provided)
 *   parsedRole     object  — pre-parsed role (optional, overrides jobDescription)
 *   weights        object  — optional custom scoring weights
 *
 * Response: ScoreBreakdown JSON
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveApiKey } from "@/lib/api-keys";
import { checkFeatureAccess } from "@/lib/subscriptions";
import { scoreCandidateStructured } from "@/lib/ai/scoring";
import { parseJobDescription } from "@/lib/ai/parsing";

const RequestSchema = z.object({
  profileText:    z.string().min(100, "profileText must be at least 100 characters"),
  jobDescription: z.string().optional(),
  parsedRole:     z.record(z.unknown()).optional(),
  weights:        z.record(z.unknown()).optional(),
});

export async function POST(req: Request) {
  // ── Authentication ─────────────────────────────────────────────────────────
  const authHeader = req.headers.get("authorization");
  const rawKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  if (!rawKey) {
    return NextResponse.json(
      { error: "Missing Authorization header. Use: Authorization: Bearer rm_..." },
      { status: 401 },
    );
  }

  const orgId = await resolveApiKey(rawKey);
  if (!orgId) {
    return NextResponse.json({ error: "Invalid or revoked API key" }, { status: 401 });
  }

  // ── Feature gate ────────────────────────────────────────────────────────────
  const access = await checkFeatureAccess(orgId, "hasApiAccess");
  if (!access.allowed) {
    return NextResponse.json({ error: access.reason }, { status: 403 });
  }

  // ── Parse request ──────────────────────────────────────────────────────────
  const body = await req.json().catch(() => null);
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request body", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { profileText, jobDescription, parsedRole: providedRole, weights } = parsed.data;

  if (!jobDescription && !providedRole) {
    return NextResponse.json(
      { error: "Either jobDescription or parsedRole is required" },
      { status: 400 },
    );
  }

  // ── Parse JD if not provided ───────────────────────────────────────────────
  let role;
  if (providedRole) {
    role = providedRole;
  } else {
    try {
      role = await parseJobDescription(jobDescription!);
    } catch (err) {
      return NextResponse.json(
        { error: "Failed to parse job description", detail: err instanceof Error ? err.message : String(err) },
        { status: 422 },
      );
    }
  }

  // ── Score ──────────────────────────────────────────────────────────────────
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const breakdown = await scoreCandidateStructured(profileText, role as any, null, weights as any, orgId);
    return NextResponse.json(breakdown);
  } catch (err) {
    return NextResponse.json(
      { error: "Scoring failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
