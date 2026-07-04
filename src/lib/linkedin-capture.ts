import { prisma } from "./db";
import { Prisma } from "@prisma/client";
import { baseScoreUpdateData } from "./base-score";
import { getJobTargetLocation } from "./job-target-location";
import {
  extractCandidateInfo,
  type ParsedRole,
} from "./ai";
import { buildScoreCacheKey, safeParseJson } from "./utils";
import { reportError } from "./error-reporting";
import { normaliseLinkedInUrl } from "./linkedin";
import {
  isConfirmedOutOfAreaForLocalRole,
  shouldRejectAsOverseas,
  isExplicitlyOverseasLocation,
  isNzLocation,
  isPlausibleLocation,
} from "./location";
import { getJobScoringWeights } from "./scoring-config";

export { linkedInProfileMatches, linkedInSlugAliasKey, normaliseLinkedInUrl } from "./linkedin";

// Multi-session queue — stores ExtensionCaptureSession[] as JSON.
export const LINKEDIN_EXTENSION_QUEUE_KEY = "LINKEDIN_EXTENSION_QUEUE_V1";

const SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes

export type ExtensionCaptureStatus = "pending" | "processing" | "completed" | "error";

export interface ExtensionCaptureSession {
  sessionId: string;
  userId?: string;
  orgId?: string | null;
  jobId: string;
  candidateId: string;
  linkedinUrl: string;
  candidateName: string;
  status: ExtensionCaptureStatus;
  message: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  candidate?: unknown;
}

const CAPTURE_STOP_LINE_PATTERNS = [
  /^more profiles for you$/i,
  /^people you may know$/i,
  /^people also viewed$/i,
  /^others (named|viewed)/i,
  /^promoted$/i,
  /^suggested for you$/i,
  /^pages for you$/i,
  /^explore premium profiles$/i,
  /^linkedin corporation/i,
  /^recommendation transparency$/i,
  /^select language$/i,
  /^manage your account and privacy$/i,
  /^visit our help center\.$/i,
];

const CAPTURE_NOISE_LINE_PATTERNS = [
  /^message$/i,
  /^follow$/i,
  /^connect$/i,
  /^contact info$/i,
  /^save in sales navigator$/i,
  /^activity$/i,
  /^open to$/i,
  /^more$/i,
  /^show all$/i,
  /^show all \d+ .+$/i,
  /^show all\s+[→>]$/i,
  /^see all$/i,
  /^see all \d+ .+$/i,
  /^…\s*more$/i,
  /^\.{3}\s*more$/i,
  /^[·•]?\s*\d+(st|nd|rd|th)$/i,
  /^connections?$/i,
  /^followers$/i,
  /^\d+\+?\s+connections?$/i,
  /^\d+\+?\s+followers$/i,
  /^\d+\s+endorsements?$/i,
  /^.* has no recent posts$/i,
  /^recent posts .* displayed here\.$/i,
  /^from .* industry$/i,
  /^.{3,60} is a mutual connection$/i,
  /^\d+ mutual connections?$/i,
  /^you(?:'re| are) connected$/i,
  /^\d+ connections? in common$/i,
  // Connection-prompt chrome. LinkedIn renders this block (Highlights →
  // "Get introduced to X" → mutual-connection lines → "Message top
  // connections") ABOVE the real About/Experience, so these are NOISE to
  // skip per-line, NOT a STOP — stopping here would truncate the whole
  // profile. Anchored ^…$ so a real About sentence merely *containing* these
  // words (e.g. "Highlights of my career…", "…across 3 offices.") is kept.
  /^highlights$/i,
  /^get introduced to .+$/i,
  /^ask your mutual connections to help you start a conversation\.?$/i,
  /^message top connections$/i,
  /^now is a great time to start a conversation\.?$/i,
  /^introduce myself$/i,
  // "Han, Teresa and 1 other mutual connection" / "X and Y are mutual connections".
  /^.{2,80} and \d+ others? mutual connection$/i,
  /^.{2,80} and .{2,40} are mutual connections$/i,
  // Comma-grouped counts ("1,056 followers", "342 connections") that the
  // bare-\d+ patterns above miss because of the thousands separator.
  /^[\d,]+\+?\s+followers$/i,
  /^[\d,]+\+?\s+connections?$/i,
  // LinkedIn activity/post lines: "1mo • We are hiring…", "2w • …", "3d • …".
  /^\d+\s*(?:mo|w|d|h|m|yr|y)\b.*[·•]/i,
];

function normalizeCaptureLine(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function sanitizeCapturedLinkedInText(profileText: string): string {
  const lines = profileText
    .replace(/\u00a0/g, " ")
    .split(/\r?\n+/)
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
    .filter(Boolean);

  const cleaned: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (CAPTURE_STOP_LINE_PATTERNS.some((pattern) => pattern.test(line))) break;
    if (CAPTURE_NOISE_LINE_PATTERNS.some((pattern) => pattern.test(line))) continue;
    if (/^\d+$/.test(line) && /^(connections?|followers)$/i.test(lines[i + 1] || "")) {
      i += 1;
      continue;
    }
    if (/^about accessibility talent solutions/i.test(line)) break;

    const key = normalizeCaptureLine(line);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    cleaned.push(line);
  }

  return cleaned.join("\n").trim();
}

export function looksLikeCapturedName(value: string | null | undefined): boolean {
  if (!value || value.length < 4 || value.length > 80) return false;
  if (/[|,@\d]/.test(value)) return false;
  if (isNzLocation(value) || isExplicitlyOverseasLocation(value)) return false;

  const words = value.trim().split(/\s+/);
  if (words.length < 2 || words.length > 5) return false;

  return words.every((word) => /^[A-Z][A-Za-z.'’-]*$/.test(word));
}

// Action-verb-only lines that LinkedIn search cards sometimes leak into the
// name/headline/location slots (the card's CTA button text, not profile data).
const CARD_ACTION_ONLY = /^(message|follow|connect|view profile|view|save|more|open to|promoted|premium)$/i;

/**
 * Lightweight sanity check for a free-text search-card field (headline or
 * location) before it's written RAW into SearchRunResult. Rejects the obvious
 * garbage the harvester picks up off the results page: empty strings, lone
 * action-verb/CTA text, URLs, and absurdly long blobs. Returns the trimmed
 * value when it passes, or null to drop it.
 *
 * This is deliberately permissive (it is NOT a positive headline heuristic) —
 * the search card is a low-stakes preview, so we only filter junk that is
 * clearly not human-readable profile text.
 */
export function sanitizeCardField(value: string | null | undefined): string | null {
  if (value == null) return null;
  const v = value.trim();
  if (!v || v.length > 120) return null;
  if (CARD_ACTION_ONLY.test(v)) return null;
  if (/https?:\/\//i.test(v) || /\bwww\.|linkedin\.com|seek\.co/i.test(v)) return null;
  return v;
}

function looksLikeCapturedLocation(value: string): boolean {
  if (!value || value.length < 3) return false;
  // Real locations are short — "Wellington, New Zealand" is 3 words, never 7+
  if (value.trim().split(/\s+/).length > 6) return false;
  if (!isPlausibleLocation(value)) return false;
  if (isNzLocation(value) || isExplicitlyOverseasLocation(value)) return true;
  return /^[A-Za-z .'-]+,\s*[A-Za-z .'-]+(?:,\s*[A-Za-z .'-]+)?$/.test(value);
}

function looksLikeMetaLine(value: string): boolean {
  return /^(she\/her|he\/him|they\/them|she\s*\/\s*they|he\s*\/\s*they|contact info|message|follow|connect|save in sales navigator|open to|top skills|about|experience|education)$/i.test(
    value
  );
}

// Role/title keywords that signal a line is a headline rather than a stray
// company name or nav word. Matched case-insensitively as whole words.
const HEADLINE_ROLE_KEYWORDS =
  /\b(engineer|manager|developer|lead|consultant|analyst|specialist|director|architect|officer|designer|scientist|administrator|coordinator|advisor|adviser|recruiter|founder|owner|president|head of|principal|associate|executive|technician|accountant|teacher|nurse|partner|strategist|programmer|administrator)\b/i;

/**
 * Positive heuristic: does this line look like a real role/headline, vs. a
 * bare company name or stray nav token? Accept only when it carries headline
 * structure (" at ", a separator like |/•, or a role keyword) OR is a
 * multi-word Title-Case phrase. A single bare token is never a headline.
 *
 * Without this guard the headline was simply "the first non-meta line after
 * the name" — which on noisy captures grabbed a lone company name ("Datacom")
 * or a nav word and stored it as the candidate's headline.
 */
function looksLikeHeadline(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  const words = v.split(/\s+/);
  // A single bare token (e.g. "Datacom", "Promoted") is never a headline.
  if (words.length < 2) return false;
  if (looksLikeMetaLine(v) || looksLikeCapturedLocation(v)) return false;

  if (/\bat\b/i.test(v)) return true;
  if (/[|•·]/.test(v)) return true;
  if (HEADLINE_ROLE_KEYWORDS.test(v)) return true;

  // Multi-word Title-Case phrase (most words start uppercase) — e.g.
  // "Artificial Intelligence Practice Lead". Allow short connector words
  // (of/and/the/in/for/&) to be lowercase.
  const connectors = new Set(["of", "and", "the", "in", "for", "to", "&", "a", "an", "on", "with"]);
  const significant = words.filter((w) => !connectors.has(w.toLowerCase()));
  const titleCaseCount = significant.filter((w) => /^[A-Z]/.test(w)).length;
  return significant.length >= 2 && titleCaseCount === significant.length;
}

export function extractIdentityFromLinkedInProfileText(profileText: string): {
  name: string;
  headline: string;
  location: string;
} {
  const lines = sanitizeCapturedLinkedInText(profileText)
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8);

  if (lines.length === 0) {
    return { name: "", headline: "", location: "" };
  }

  const name = looksLikeCapturedName(lines[0]) ? lines[0] : "";

  let headline = "";
  let location = "";

  for (const line of lines.slice(name ? 1 : 0)) {
    if (!location && looksLikeCapturedLocation(line)) {
      location = line;
      continue;
    }
    if (!headline && looksLikeHeadline(line)) {
      headline = line;
    }
    if (headline && location) break;
  }

  return { name, headline, location };
}

// ---------------------------------------------------------------------------
// Multi-session queue helpers — backed by FetchSession table (was Setting JSON)
// ---------------------------------------------------------------------------

function dbRowToSession(row: {
  id: string; jobId: string; candidateId: string; linkedinUrl: string;
  candidateName: string; status: string; message: string; error: string | null;
  completedAt: Date | null; orgId: string | null; userId: string | null;
  createdAt: Date; updatedAt: Date;
}): ExtensionCaptureSession {
  return {
    sessionId:     row.id,
    jobId:         row.jobId,
    candidateId:   row.candidateId,
    linkedinUrl:   row.linkedinUrl,
    candidateName: row.candidateName,
    status:        row.status as ExtensionCaptureStatus,
    message:       row.message,
    error:         row.error ?? undefined,
    completedAt:   row.completedAt?.toISOString(),
    orgId:         row.orgId,
    userId:        row.userId ?? undefined,
    createdAt:     row.createdAt.toISOString(),
    updatedAt:     row.updatedAt.toISOString(),
  };
}

/** Returns all non-expired sessions currently in the queue. */
export async function getSessionQueue(): Promise<ExtensionCaptureSession[]> {
  const cutoff = new Date(Date.now() - SESSION_TTL_MS);
  const rows = await prisma.fetchSession.findMany({
    where: { updatedAt: { gte: cutoff } },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => dbRowToSession(r));
}

/** Add (or replace an existing session for the same candidateId) in the queue. */
export async function addSessionToQueue(session: ExtensionCaptureSession): Promise<void> {
  // Delete any stale session for this candidate then create a fresh one in a
  // single transaction. We need a new row (new PK = new sessionId) each time so
  // the web UI can poll by the sessionId it received — updating the PK in place
  // via upsert is not safe across all Prisma/PostgreSQL versions.
  await prisma.$transaction([
    prisma.fetchSession.deleteMany({ where: { candidateId: session.candidateId } }),
    prisma.fetchSession.create({
      data: {
        id:            session.sessionId,
        jobId:         session.jobId,
        candidateId:   session.candidateId,
        linkedinUrl:   session.linkedinUrl,
        candidateName: session.candidateName,
        status:        session.status,
        message:       session.message,
        error:         session.error ?? null,
        orgId:         session.orgId ?? null,
        userId:        session.userId ?? null,
      },
    }),
  ]);
}

/** Find the first session matching a predicate. */
export async function findSessionInQueue(
  predicate: (s: ExtensionCaptureSession) => boolean
): Promise<ExtensionCaptureSession | null> {
  const queue = await getSessionQueue();
  return queue.find(predicate) ?? null;
}

/** Update a session in the queue by sessionId. Returns the updated session or null if not found. */
export async function updateSessionInQueue(
  patch: Partial<ExtensionCaptureSession> & Pick<ExtensionCaptureSession, "sessionId">
): Promise<ExtensionCaptureSession | null> {
  const existing = await prisma.fetchSession.findUnique({ where: { id: patch.sessionId } });
  if (!existing) return null;
  const updated = await prisma.fetchSession.update({
    where: { id: patch.sessionId },
    data: {
      ...(patch.status      !== undefined && { status:      patch.status }),
      ...(patch.message     !== undefined && { message:     patch.message }),
      ...(patch.error       !== undefined && { error:       patch.error }),
      ...(patch.completedAt !== undefined && { completedAt: new Date(patch.completedAt) }),
    },
  });
  return dbRowToSession(updated);
}

/** Remove a session from the queue by sessionId. */
export async function removeSessionFromQueue(sessionId: string): Promise<void> {
  await prisma.fetchSession.delete({ where: { id: sessionId } }).catch((err) => {
    // P2025 (record-not-found) is expected when the session has already been
    // cleaned up; ignore it. Surface every other failure so we notice if
    // we're leaking rows.
    if (err && typeof err === "object" && (err as { code?: string }).code === "P2025") return;
    reportError(err, { fn: "removeSessionFromQueue", sessionId });
  });
}

/**
 * Merge `{scoringError, scoringErrorAt}` into the candidate's `screeningData`
 * JSON without clobbering existing fields. Returns a JSON string ready to
 * write straight into the `screeningData` column.
 *
 * Use this in catch blocks where scoring failed but the candidate row still
 * exists — leaving `matchScore: null` alone is half the story; we also need
 * a recruiter-visible "this candidate's score blew up because X" trail so
 * "Imported N / Scored 0" stops being a silent void.
 */
export function mergeScoringError(
  existing: string | null | undefined,
  reason: string,
): string {
  const base = safeParseJson<Record<string, unknown>>(existing ?? null, {});
  return JSON.stringify({
    ...base,
    scoringError: reason,
    scoringErrorAt: new Date().toISOString(),
  });
}

// ─── Two-stage capture pipeline ────────────────────────────────────────────
//
// Stage 1 (sync, no AI):   buildIdentityData → save profileText + regex-
//                          extracted name/headline/location + computed
//                          profileTextHash. ~50ms.
//
// Stage 2 (async, AI):     runAiEnrichment → run extractCandidateInfo +
//                          scoreCandidateStructured + predictAcceptance,
//                          patch the same row using profileTextHash as a
//                          concurrency token. ~5–30s.
//
// The split exists so the candidate appears as "captured" within ~1 second of
// the extension POSTing, instead of after AI scoring lands. If the recruiter
// closes the page mid-capture and returns later, the candidate is already
// shown as captured because Stage 1 persisted it before the response was sent.

interface IdentityData {
  cleanedProfileText: string;
  name: string;
  headline: string | null;
  location: string | null;
  currentStatus: string;
  hasDirectName: boolean;
  hasDirectHeadline: boolean;
  hasDirectLocation: boolean;
  orgId: string | null;
  linkedinUrl: string;
  profileCapturedAt: Date;
  profileTextHash: string | null;
  profileUnchanged: boolean;
  // Cached for stage 2 so it doesn't have to re-fetch.
  job: NonNullable<Awaited<ReturnType<typeof prisma.job.findUnique>>>;
  parsedRole: ParsedRole | null;
  salary: { min: number; max: number } | null;
  weights: Awaited<ReturnType<typeof getJobScoringWeights>>;
}

async function buildIdentityData(args: {
  jobId: string;
  currentName: string;
  currentHeadline: string | null;
  currentLocation: string | null;
  currentStatus: string;
  currentProfileTextHash: string | null;
  profileText: string;
  linkedinUrl: string;
}): Promise<IdentityData> {
  const {
    jobId,
    currentName,
    currentHeadline,
    currentLocation,
    currentStatus,
    currentProfileTextHash,
    profileText,
    linkedinUrl,
  } = args;
  const cleanedProfileText = sanitizeCapturedLinkedInText(profileText);
  if (cleanedProfileText.length < 200) {
    throw new Error("Captured LinkedIn profile did not contain enough usable profile text");
  }

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) {
    throw new Error("Job not found");
  }

  let name = currentName;
  let headline = currentHeadline;
  let location = currentLocation;

  const extracted = extractIdentityFromLinkedInProfileText(cleanedProfileText);
  if (extracted.name) name = extracted.name;
  if (extracted.headline) headline = extracted.headline;
  if (extracted.location) location = extracted.location;

  const parsedRole = safeParseJson<ParsedRole | null>(job.parsedRole, null);
  const salary =
    job.salaryMin || job.salaryMax
      ? { min: job.salaryMin ?? 0, max: job.salaryMax ?? 0 }
      : null;
  const weights = await getJobScoringWeights(job.scoringWeights, job.orgId);

  // Compute profileTextHash NOW (in stage 1) — it's a deterministic hash
  // with no AI calls. Storing it eagerly means stage 2 can use it as the
  // concurrency token for its conditional update; if a faster path lands
  // a manual re-score in between, stage 2 detects the hash change and
  // skips silently rather than clobbering the newer data.
  const profileTextHash = parsedRole
    ? buildScoreCacheKey({
        profileText: cleanedProfileText,
        parsedRole,
        salary,
        jobLocation: job.location,
        jobLocation2: job.location2,
        isRemote: job.isRemote,
        weights,
      })
    : null;
  // Only skip Stage 2 when the existing score cache key proves the stored
  // score was computed against this exact profile text and the current
  // role/scoring inputs. A fuzzy "similar profile" shortcut is unsafe:
  // LinkedIn can add a few older work-history lines (e.g. C++/Sybase) while
  // the text remains 85% similar, and those lines can completely change the
  // recruiting verdict.
  const profileUnchanged =
    !!profileTextHash &&
    !!currentProfileTextHash &&
    currentProfileTextHash === profileTextHash;

  return {
    cleanedProfileText,
    name,
    headline,
    location,
    currentStatus,
    hasDirectName: Boolean(extracted.name),
    hasDirectHeadline: Boolean(extracted.headline),
    hasDirectLocation: Boolean(extracted.location),
    orgId: job.orgId ?? null,
    linkedinUrl: normaliseLinkedInUrl(linkedinUrl),
    profileCapturedAt: new Date(),
    profileTextHash,
    profileUnchanged,
    job,
    parsedRole,
    salary,
    weights,
  };
}

// Stage 1 DB write payload — everything we know without calling Claude.
function identityToCandidateUpdate(identity: IdentityData) {
  // When the profile is unchanged we DON'T clear score fields — the existing
  // score was computed against the same text and remains valid. When changed,
  // clear stale score fields so the candidate card shows "captured but not
  // yet scored" until stage 2 lands.
  // fetchPriority* fields are cleared because they were a pre-fetch ranking
  // that no longer applies once we have a full profile.
  const scoreClears: Record<string, unknown> = identity.profileUnchanged
    ? {}
    : {
        matchScore: null,
        matchReason: null,
        scoreBreakdown: null,
        acceptanceScore: null,
        acceptanceReason: null,
        fetchPriorityScore: null,
        fetchPriorityReason: null,
      };
  return {
    name: identity.name,
    headline: identity.headline,
    location: identity.location,
    orgId: identity.orgId,
    linkedinUrl: identity.linkedinUrl,
    profileText: identity.cleanedProfileText,
    profileCapturedAt: identity.profileCapturedAt,
    profileTextHash: identity.profileTextHash,
    ...scoreClears,
  };
}

// Stage 2 — three Claude calls in parallel, returns the field updates.
// Returns null if all AI calls fail (DB write becomes a no-op). When the
// structured scorer specifically fails (vs. extractCandidateInfo /
// predictAcceptance), `scoringError` is populated so the caller can mark
// the candidate row with a recruiter-visible failure flag instead of
// silently dropping the score.
async function runAiEnrichment(identity: IdentityData): Promise<{
  update: Record<string, unknown> | null;
  scoringError: string | null;
}> {
  const { cleanedProfileText, currentStatus, parsedRole, weights, job, profileUnchanged } = identity;

  if (profileUnchanged) {
    // Existing score is still valid — nothing to do in stage 2.
    return { update: null, scoringError: null };
  }

  const enrichContext = { fn: "runAiEnrichment", jobId: job.id, orgId: job.orgId ?? null, linkedinUrl: identity.linkedinUrl };
  let scoringError: string | null = null;
  // Identity refinement stays an AI call (parsing, not judgment — regex can't
  // reliably pull name/headline/location from arbitrary profile text). The
  // SCORE is now the deterministic full-evidence heuristic, computed below —
  // capture costs one Claude call instead of three, and scoring judgment is
  // on demand via the job page's Score / Re-score buttons.
  const info = await extractCandidateInfo(cleanedProfileText, { orgId: job.orgId ?? null }).catch((err) => {
    reportError(err, { ...enrichContext, phase: "extractCandidateInfo" });
    return null;
  });

  // Refine identity ONLY where stage 1's regex extraction left a field null.
  // If the recruiter manually edited a field between stage 1 and stage 2,
  // we don't clobber — the conditional update below is keyed on
  // profileTextHash, so a manual edit that changes the text invalidates this.
  let name = identity.name;
  let headline = identity.headline;
  let location = identity.location;
  if (info) {
    if (!identity.hasDirectName && info.name && info.name !== "Unknown" && info.name.length > 2) name = info.name;
    if (!identity.hasDirectHeadline && info.headline && info.headline.length > 2) headline = info.headline;
    if (!identity.hasDirectLocation && info.location && info.location.length > 2) location = info.location;
  }

  const update: Record<string, unknown> = {};
  if (name     !== identity.name)     update.name = name;
  if (headline !== identity.headline) update.headline = headline;
  if (location !== identity.location) update.location = location;

  if (parsedRole) {
    try {
      // Deterministic full-evidence fit score from the captured profile text.
      // CRITICAL: also null profileTextHash — stage 1 stamped the real cache
      // key, and leaving it beside a heuristic score would make score-all's
      // cache check treat this row as "already AI-scored" and skip it forever.
      // The concurrency-gated updateMany below matches on the OLD hash, so
      // the guard still works; the write then clears it.
      Object.assign(update, baseScoreUpdateData(
        { name, headline, location, evidenceText: cleanedProfileText },
        job,
        parsedRole,
        weights,
      ));
      update.profileTextHash = null;
    } catch (err) {
      scoringError = err instanceof Error ? err.message : String(err);
      reportError(err, { ...enrichContext, phase: "heuristic-base-score" });
    }

    if (["new", "reviewing"].includes(currentStatus)) {
      // Country gate uses the full inference (Present-role location + "based
      // in" phrases + +64/+61 phone + definitely-overseas employer in current
      // role). Two-signal rule means returnee Kiwis aren't false-rejected
      // just because old roles mention London/Sydney.
      const overseas = shouldRejectAsOverseas({
        explicitLocation: location,
        headline,
        profileText: cleanedProfileText,
        isRemote: job.isRemote,
      });
      if (overseas.reject) {
        update.status = "rejected";
      } else if (
        // Keep the city-distance reject for the very out-of-area NZ cases
        // (e.g. Whangarei for a Wellington office role) only when explicit.
        isConfirmedOutOfAreaForLocalRole(location, getJobTargetLocation(job, parsedRole), parsedRole.location_rules, job.isRemote)
      ) {
        update.status = "rejected";
      }
    }
  }
  return {
    update: Object.keys(update).length > 0 ? update : null,
    scoringError,
  };
}

// Apply stage 2 results to the candidate row, gated on profileTextHash so a
// concurrent edit doesn't get clobbered. Returns true if the write applied,
// false if the hash mismatched (a fresher edit landed first).
//
// Status-rejected (set by the country gate) applies in a SEPARATE write with
// a stricter where clause: only when the row is still in pre-decision status
// ("new" or "reviewing"). Without this, a recruiter who manually moved the
// candidate to "shortlisted" while stage 2 was in flight would have their
// choice silently clobbered by the overseas auto-reject.
async function applyAiEnrichment(
  candidateId: string,
  expectedHash: string | null,
  update: Record<string, unknown>,
): Promise<boolean> {
  const { status, ...updateWithoutStatus } = update;

  // Score / acceptance / location etc. — applied with the standard
  // profileTextHash gate.
  const result = Object.keys(updateWithoutStatus).length > 0
    ? await prisma.candidate.updateMany({
        where: { id: candidateId, profileTextHash: expectedHash },
        data: updateWithoutStatus,
      })
    : { count: 0 };

  // Auto-reject status — only applies if the row is still in pre-decision
  // status. If the recruiter has progressed it to shortlisted / contacted /
  // hired / declined, we leave their decision alone.
  if (status === "rejected") {
    await prisma.candidate.updateMany({
      where: {
        id: candidateId,
        profileTextHash: expectedHash,
        status: { in: ["new", "reviewing"] },
      },
      data: { status: "rejected" },
    });
  } else if (typeof status === "string") {
    // Other status writes (rare from this path) use the standard gate.
    await prisma.candidate.updateMany({
      where: { id: candidateId, profileTextHash: expectedHash },
      data: { status },
    });
  }

  return result.count > 0;
}

// Stage 1 of saveCapturedProfileToCandidate — does the fast persist (no AI).
// Returns the candidate row + profileTextHash so the caller can pass that to
// applyAiEnrichmentInBackground as the concurrency token for stage 2.
export async function saveCapturedProfileFast(args: {
  jobId: string;
  candidateId: string;
  profileText: string;
  linkedinUrl: string;
  captureMeta?: unknown;
}): Promise<{ candidate: NonNullable<Awaited<ReturnType<typeof prisma.candidate.findUnique>>>; identity: IdentityData; }> {
  const { jobId, candidateId, profileText, linkedinUrl, captureMeta } = args;

  const candidate = await prisma.candidate.findUnique({ where: { id: candidateId } });
  if (!candidate || candidate.jobId !== jobId) {
    throw new Error("Candidate not found");
  }

  const identity = await buildIdentityData({
    jobId,
    currentName: candidate.name,
    currentHeadline: candidate.headline,
    currentLocation: candidate.location,
    currentStatus: candidate.status,
    currentProfileTextHash: candidate.profileTextHash,
    profileText: profileText.trim(),
    linkedinUrl,
  });

  const captureMetadata = captureMeta != null
    ? JSON.stringify(captureMeta).slice(0, 8000)
    : undefined;

  const baseUpdate = {
    ...identityToCandidateUpdate(identity),
    source: "extension",
    ...(captureMetadata !== undefined ? { captureMetadata } : {}),
  };

  let updated;
  try {
    updated = await prisma.candidate.update({ where: { id: candidateId }, data: baseUpdate });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Another candidate in this job already owns this LinkedIn URL — the
      // canonical record. Refuse to write profileText/identity to the
      // duplicate row; previously we stripped only the URL and copied
      // someone else's text into the wrong record. Surface a clear error
      // so the caller can route the recruiter to the existing candidate.
      const e = new Error(
        "DUPLICATE_LINKEDIN_URL: another candidate on this job already has this LinkedIn profile."
      );
      // @ts-expect-error attach status hint for callers/tests
      e.status = 409;
      throw e;
    }
    throw err;
  }
  return { candidate: updated, identity };
}

// Stage 2 of saveCapturedProfileToCandidate — runs the AI enrichment and
// patches the row using profileTextHash as the concurrency token. Skip
// silently if the hash has changed in the meantime (someone re-scored or
// re-captured between stage 1 and stage 2).
export async function applyAiEnrichmentInBackground(
  candidateId: string,
  identity: IdentityData,
): Promise<{ applied: boolean }> {
  const { update, scoringError } = await runAiEnrichment(identity);

  // Scoring blew up. The candidate row already has matchScore: null (cleared
  // by stage 1 when the profile changed). Surface the error to the recruiter
  // via screeningData.scoringError so they're not staring at a quiet "Scored
  // 0" without an explanation. profileTextHash guard makes this safe under
  // concurrent re-captures — if the row has moved on, our flag is stale and
  // we deliberately skip rather than overwrite the fresher write.
  if (scoringError) {
    const current = await prisma.candidate.findUnique({
      where: { id: candidateId },
      select: { screeningData: true },
    });
    await prisma.candidate.updateMany({
      where: { id: candidateId, profileTextHash: identity.profileTextHash },
      data: {
        matchScore: null,
        screeningData: mergeScoringError(current?.screeningData ?? null, scoringError),
      },
    });
  }

  if (!update) return { applied: false };
  const applied = await applyAiEnrichment(candidateId, identity.profileTextHash, update);
  return { applied };
}

// Backwards-compat wrapper for callers (e.g. tests) that want the full
// captured-and-scored row in a single await. Equivalent to fast + background
// run sequentially.
export async function saveCapturedProfileToCandidate(args: {
  jobId: string;
  candidateId: string;
  profileText: string;
  linkedinUrl: string;
  captureMeta?: unknown;
}) {
  const { candidate, identity } = await saveCapturedProfileFast(args);
  await applyAiEnrichmentInBackground(args.candidateId, identity).catch((err) => {
    reportError(err, { fn: "applyAiEnrichmentInBackground", candidateId: args.candidateId });
    return { applied: false };
  });
  // Return the latest candidate state so the caller sees scores if they landed.
  return prisma.candidate.findUnique({ where: { id: args.candidateId } }) ?? candidate;
}

// Stage 1 of importCapturedLinkedInProfile — fast persist, no AI. Returns
// candidate + identity so the caller can fire stage 2 as a background Promise.
export async function importCapturedLinkedInProfileFast(args: {
  jobId: string;
  linkedinUrl: string;
  profileText: string;
  source?: string;
  captureMeta?: unknown;
}): Promise<{ candidate: NonNullable<Awaited<ReturnType<typeof prisma.candidate.findUnique>>>; identity: IdentityData; }> {
  const { jobId, linkedinUrl, profileText, source = "extension", captureMeta } = args;
  const cleanUrl = normaliseLinkedInUrl(linkedinUrl);

  // Match by normalised URL to handle variants stored by SerpAPI or manual entry.
  const jobCandidates = await prisma.candidate.findMany({
    where: { jobId },
    select: { id: true, linkedinUrl: true },
  });
  const existingRef = jobCandidates.find(
    (c) => c.linkedinUrl != null && normaliseLinkedInUrl(c.linkedinUrl) === cleanUrl
  );
  const existing = existingRef
    ? await prisma.candidate.findUnique({ where: { id: existingRef.id } })
    : null;

  const identity = await buildIdentityData({
    jobId,
    currentName: existing?.name ?? "Unknown",
    currentHeadline: existing?.headline ?? null,
    currentLocation: existing?.location ?? null,
    currentStatus: existing?.status ?? "new",
    currentProfileTextHash: existing?.profileTextHash ?? null,
    profileText: profileText.trim(),
    linkedinUrl: cleanUrl,
  });

  const captureMetadata = captureMeta != null
    ? JSON.stringify(captureMeta).slice(0, 8000)
    : undefined;

  const baseUpdate = {
    ...identityToCandidateUpdate(identity),
    source,
    ...(captureMetadata !== undefined ? { captureMetadata } : {}),
  };

  const candidate = existing
    ? await prisma.candidate.update({ where: { id: existing.id }, data: baseUpdate })
    : await prisma.candidate.create({
        data: { jobId, status: "new", ...baseUpdate },
      });

  return { candidate, identity };
}

// Backwards-compat wrapper — runs fast + background sequentially. The
// /api/extension/import route uses the explicit two-step pattern instead so
// it can return 202-equivalent quickly.
export async function importCapturedLinkedInProfile(args: {
  jobId: string;
  linkedinUrl: string;
  profileText: string;
  source?: string;
  captureMeta?: unknown;
}) {
  const { candidate, identity } = await importCapturedLinkedInProfileFast(args);
  await applyAiEnrichmentInBackground(candidate.id, identity).catch((err) => {
    reportError(err, { fn: "applyAiEnrichmentInBackground", candidateId: candidate.id });
    return { applied: false };
  });
  return prisma.candidate.findUnique({ where: { id: candidate.id } }) ?? candidate;
}
