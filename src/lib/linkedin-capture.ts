import { prisma } from "./db";
import { Prisma } from "@prisma/client";
import { applyLocationFitOverride, deriveUpdateData } from "./score-utils";
import {
  extractCandidateInfo,
  predictAcceptance,
  scoreCandidateStructured,
  type ParsedRole,
} from "./ai";
import { buildScoreCacheKey, safeParseJson } from "./utils";
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

function looksLikeCapturedName(value: string): boolean {
  if (!value || value.length < 4 || value.length > 80) return false;
  if (/[|,@\d]/.test(value)) return false;
  if (isNzLocation(value) || isExplicitlyOverseasLocation(value)) return false;

  const words = value.trim().split(/\s+/);
  if (words.length < 2 || words.length > 5) return false;

  return words.every((word) => /^[A-Z][A-Za-z.'’-]*$/.test(word));
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
    if (!headline && !looksLikeMetaLine(line) && !looksLikeCapturedLocation(line)) {
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
  await prisma.fetchSession.delete({ where: { id: sessionId } }).catch(() => {});
}

// ---------------------------------------------------------------------------
// AI scoring helpers
// ---------------------------------------------------------------------------

function buildAcceptanceData(acceptance: Awaited<ReturnType<typeof predictAcceptance>>) {
  return {
    acceptanceScore: acceptance.score,
    acceptanceReason: JSON.stringify({
      likelihood: acceptance.likelihood,
      headline: acceptance.headline,
      signals: acceptance.signals,
      summary: acceptance.summary,
    }),
  };
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
  // Note: provisionalScore is intentionally preserved (schema-documented as
  // "never overwritten" — it's the historical snippet-time score for delta
  // computation). fetchPriority* fields are cleared because they were a
  // pre-fetch ranking that no longer applies once we have a full profile.
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
// Returns null if all AI calls fail (DB write becomes a no-op).
async function runAiEnrichment(identity: IdentityData): Promise<Record<string, unknown> | null> {
  const { cleanedProfileText, currentStatus, parsedRole, salary, weights, job, profileUnchanged } = identity;

  if (profileUnchanged) {
    // Existing score is still valid — nothing to do in stage 2.
    return null;
  }

  const [info, rawBreakdown, acceptance] = await Promise.all([
    extractCandidateInfo(cleanedProfileText).catch(() => null),
    parsedRole
      ? scoreCandidateStructured(cleanedProfileText, parsedRole, salary, weights, job.orgId ?? null).catch(() => null)
      : Promise.resolve(null),
    cleanedProfileText.length >= 250 && parsedRole
      ? predictAcceptance(cleanedProfileText, parsedRole, salary).catch(() => null)
      : Promise.resolve(null),
  ]);

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

  if (rawBreakdown && parsedRole) {
    const breakdown = applyLocationFitOverride(
      rawBreakdown,
      location,
      parsedRole.location,
      parsedRole.location_rules,
      job.isRemote,
      weights,
    );
    Object.assign(update, deriveUpdateData(breakdown));

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
        isConfirmedOutOfAreaForLocalRole(location, parsedRole.location || job.location, parsedRole.location_rules, job.isRemote)
      ) {
        update.status = "rejected";
      }
    }
  }
  if (acceptance) {
    Object.assign(update, buildAcceptanceData(acceptance));
  }

  return Object.keys(update).length > 0 ? update : null;
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

// Backwards-compat wrapper — runs stage 1 + stage 2 sequentially and returns
// the final candidate row. Kept for tests and any caller that expects
// "save everything in one go". The hot path (the /complete route) calls
// the two stages explicitly so it can return 202 between them.
async function buildCapturedCandidateData(args: {
  jobId: string;
  currentName: string;
  currentHeadline: string | null;
  currentLocation: string | null;
  currentStatus: string;
  currentProfileTextHash: string | null;
  profileText: string;
  linkedinUrl: string;
}) {
  const identity = await buildIdentityData(args);
  const stage1 = identityToCandidateUpdate(identity);
  const stage2 = await runAiEnrichment(identity);
  return { ...stage1, ...(stage2 ?? {}) };
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
  const update = await runAiEnrichment(identity);
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
  await applyAiEnrichmentInBackground(args.candidateId, identity).catch(() => ({ applied: false }));
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
  await applyAiEnrichmentInBackground(candidate.id, identity).catch(() => ({ applied: false }));
  return prisma.candidate.findUnique({ where: { id: candidate.id } }) ?? candidate;
}
