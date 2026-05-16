import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { parseJobDescription } from "@/lib/ai";
import type { ParsedRole } from "@/lib/ai";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";
import { checkRateLimit, checkSpendCap, recordUsage } from "@/lib/usage";
import { safeParseJson } from "@/lib/utils";
import { reportError } from "@/lib/error-reporting";

// Compliance/framework terms narrow enough to be dangerous as sole anchor terms
const NARROW_CERT_RE = /\b(iso\s*\d{4,5}|isms|gdpr|pci\b|pci[-\s]?dss|sox|nist|hipaa|cissp|cism|crisc|cisa|ccsp|togaf)\b/i;

function buildParseEvaluation(role: ParsedRole, changes: string[]): string {
  const anchors      = role.anchor_terms ?? [];
  const mustHaveCount = (role.must_haves ?? []).length;
  const anchorStr    = anchors.length ? anchors.join(", ") : "none";

  if (mustHaveCount === 0) {
    return "WARNING — no must-haves extracted; scoring will be unreliable until the JD is re-analysed with more detail";
  }
  if (anchors.length === 0) {
    return `OK — ${mustHaveCount} must-have${mustHaveCount !== 1 ? "s" : ""} extracted, no anchor terms (broad search)`;
  }
  const narrowAnchors = anchors.filter((a) => NARROW_CERT_RE.test(a));
  if (narrowAnchors.length > 0 && narrowAnchors.length === anchors.length) {
    return `WARNING — anchor terms are all compliance/framework terms (${anchorStr}); these will filter out operational candidates on hybrid roles. Consider Re-analysing with more JD context or clearing anchor terms.`;
  }
  const mustHaveChanges = changes.filter((c) => c.startsWith("Must-haves:")).length;
  if (mustHaveChanges >= 3) {
    return `WARNING — ${mustHaveChanges} must-have change${mustHaveChanges !== 1 ? "s" : ""} detected; re-score all candidates to apply updated requirements. Anchors: ${anchorStr}.`;
  }
  return `OK — ${mustHaveCount} must-have${mustHaveCount !== 1 ? "s" : ""} extracted, anchor terms: ${anchorStr}`;
}

function diffParsedRole(before: ParsedRole | null, after: ParsedRole): string[] {
  if (!before) return [];
  const changes: string[] = [];

  const listDiff = (label: string, a: string[], b: string[]) => {
    const added   = b.filter((x) => !a.some((y) => y.toLowerCase() === x.toLowerCase()));
    const removed = a.filter((x) => !b.some((y) => y.toLowerCase() === x.toLowerCase()));
    if (added.length)   changes.push(`${label}: added ${added.slice(0, 3).join(", ")}${added.length > 3 ? ` +${added.length - 3} more` : ""}`);
    if (removed.length) changes.push(`${label}: removed ${removed.slice(0, 3).join(", ")}${removed.length > 3 ? ` +${removed.length - 3} more` : ""}`);
  };

  if (before.title !== after.title) changes.push(`Title: "${before.title}" → "${after.title}"`);
  if (before.seniority_band !== after.seniority_band) changes.push(`Seniority: "${before.seniority_band}" → "${after.seniority_band}"`);
  if (before.salary_band !== after.salary_band) changes.push(`Salary: "${before.salary_band}" → "${after.salary_band}"`);
  if (before.location !== after.location) changes.push(`Location: "${before.location}" → "${after.location}"`);

  listDiff("Must-haves",    before.must_haves    ?? [], after.must_haves    ?? []);
  listDiff("Nice-to-haves", before.nice_to_haves ?? [], after.nice_to_haves ?? []);
  listDiff("Knockouts",     before.knockout_criteria ?? [], after.knockout_criteria ?? []);

  const beforeAnchors = before.anchor_terms ?? [];
  const afterAnchors  = after.anchor_terms  ?? [];
  if (JSON.stringify(beforeAnchors.slice().sort()) !== JSON.stringify(afterAnchors.slice().sort())) {
    changes.push(`Search anchors: ${afterAnchors.length ? afterAnchors.join(", ") : "none"}`);
  }

  return changes;
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;
  const { job, error } = await requireJobAccess(id, auth);
  if (error || !job) return error;

  // Per-event rate-limit + daily spend cap. parseJobDescription fires
  // up to 2 Sonnet calls (initial + nudged retry); without these guards
  // a recruiter could mash "Re-analyse" and silently bypass the cap.
  const rate = await checkRateLimit(auth.orgId, "parse");
  if (!rate.allowed) {
    const waitMin = Math.ceil((rate.retryAfterMs ?? 60_000) / 60_000);
    return NextResponse.json({ error: `JD parse rate limit reached. Try again in ~${waitMin} minute${waitMin !== 1 ? "s" : ""}.` }, { status: 429 });
  }
  const spend = await checkSpendCap(auth.orgId);
  if (!spend.allowed) {
    return NextResponse.json({
      error: `Daily AI spend cap reached ($${spend.spentUsd.toFixed(2)} / $${spend.capUsd.toFixed(2)}). Try again tomorrow or raise AI_DAILY_SPEND_CAP_USD.`,
    }, { status: 429 });
  }

  try {
    const existing = safeParseJson<ParsedRole | null>(job.parsedRole, null);
    const parsedRole = await parseJobDescription(job.rawJd, { orgId: auth.orgId, userId: auth.userId });

    // Empty-requirements case. Two distinct sub-cases — distinguishable by
    // whether the title came through:
    //   (a) JD genuinely has no requirements (recruiter pasted just a
    //       responsibilities blurb). The parse will have title + maybe
    //       seniority but truly zero must-haves. Hard-fail with a clear
    //       message asking for more JD detail.
    //   (b) Claude returned malformed JSON twice → parseJobDescription's
    //       minimal-fallback path produced title only. Still empty
    //       requirements but the JD itself was probably fine. Don't
    //       hard-fail — save the role with the warning so the recruiter
    //       gets a job with the title pre-filled and can add must-haves
    //       manually rather than being blocked.
    const mustHaveCount = (parsedRole.must_haves ?? []).length;
    const skillsRequiredCount = (parsedRole.skills_required ?? []).length;
    const responsibilitiesCount = (parsedRole.responsibilities ?? []).length;
    const seniorityPresent = Boolean(parsedRole.seniority_band);
    if (mustHaveCount === 0 && skillsRequiredCount === 0) {
      const aiCompleteParse = responsibilitiesCount > 0 || seniorityPresent;
      if (aiCompleteParse) {
        // Case (a): AI got OTHER fields out, just no requirements →
        // the JD itself is too thin. Hard-fail with clear guidance.
        return NextResponse.json(
          {
            error:
              "We couldn't pull any specific requirements out of this job description. " +
              "Add a few lines about the must-have skills, seniority, and tools, then re-analyse.",
            empty_role: true,
          },
          { status: 422 }
        );
      }
      // Case (b): AI failed completely, only title made it through the
      // regex fallback. Save it anyway with a warning the UI surfaces.
      console.warn(
        `[parse] AI extraction returned only title (parse fell through to regex fallback). Saving anyway with empty_role warning so recruiter can edit fields.`,
      );
      // Fall through — the role will be saved with whatever fields exist.
      // The response below adds a warning flag.
    }

    // Preserve recruiter overrides that represent deliberate decisions.
    // dismissed_skill_notes is intentionally NOT preserved — tips are
    // informational and should reappear after a fresh re-analyse.
    if (existing?.dismissed_knockout_criteria?.length) {
      parsedRole.dismissed_knockout_criteria = existing.dismissed_knockout_criteria;
    }
    if (existing?.promoted_visa_flags?.length) {
      parsedRole.promoted_visa_flags = existing.promoted_visa_flags;
      // Re-apply promoted visa flags into must_haves so scoring stays consistent.
      for (const flag of existing.promoted_visa_flags) {
        const lower = flag.toLowerCase();
        if (!parsedRole.must_haves.some((m) => m.toLowerCase() === lower)) {
          parsedRole.must_haves = [...parsedRole.must_haves, flag];
        }
        if (!parsedRole.skills_required.some((s) => s.toLowerCase() === lower)) {
          parsedRole.skills_required = [...parsedRole.skills_required, flag];
        }
      }
    }

    // Save parsed role back to job and stamp lastParsedAt so the UI can show
    // "re-score recommended" when requirements have changed since last score-all.
    await prisma.job.update({
      where: { id },
      data: { parsedRole: JSON.stringify(parsedRole), lastParsedAt: new Date() },
    });

    const changes = diffParsedRole(existing, parsedRole);
    const evaluation = buildParseEvaluation(parsedRole, changes);

    // Write history asynchronously — never block the response.
    void prisma.jobParseHistory.create({
      data: {
        jobId:         id,
        anchorTerms:   JSON.stringify(parsedRole.anchor_terms ?? []),
        mustHaveCount: (parsedRole.must_haves ?? []).length,
        changes:       JSON.stringify(changes),
        evaluation,
      },
    }).catch((err) => reportError(err, { route: "jobs/[id]/parse:history", jobId: id }));

    void recordUsage(auth.orgId, auth.userId, "parse", { jobId: id });
    // Surface the regex-fallback path so the UI can show a "review and fill
    // missing fields" hint rather than letting the recruiter assume the
    // parse was complete. mustHaveCount===0 && skillsRequiredCount===0 at
    // this point means the case (b) branch above let it through.
    const fellBackToRegex =
      (parsedRole.must_haves ?? []).length === 0 &&
      (parsedRole.skills_required ?? []).length === 0;
    return NextResponse.json({
      parsedRole,
      changes,
      evaluation,
      ...(fellBackToRegex ? { warning: "AI parse returned no requirements — title saved from regex fallback. Edit fields manually or re-analyse." } : {}),
    });
  } catch (err) {
    reportError(err, { route: "jobs/[id]/parse", jobId: id, orgId: auth.orgId });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "AI parsing failed" },
      { status: 500 }
    );
  }
}
