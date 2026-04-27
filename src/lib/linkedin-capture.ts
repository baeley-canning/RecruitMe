import { prisma } from "./db";
import { applyLocationFitOverride, deriveUpdateData } from "./score-utils";
import {
  extractCandidateInfo,
  predictAcceptance,
  scoreCandidateStructured,
  type ParsedRole,
} from "./ai";
import { buildScoreCacheKey, safeParseJson } from "./utils";
import { isProfileUnchanged } from "./talent-pool";
import { normaliseLinkedInUrl } from "./linkedin";
import { isExplicitlyOverseasLocation, isNzLocation } from "./location";

export { normaliseLinkedInUrl } from "./linkedin";

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

async function buildCapturedCandidateData(args: {
  jobId: string;
  currentName: string;
  currentHeadline: string | null;
  currentLocation: string | null;
  currentProfileText: string | null;
  profileText: string;
  linkedinUrl: string;
}) {
  const { jobId, currentName, currentHeadline, currentLocation, currentProfileText, profileText, linkedinUrl } = args;
  const cleanedProfileText = sanitizeCapturedLinkedInText(profileText);
  if (cleanedProfileText.length < 200) {
    throw new Error("Captured LinkedIn profile did not contain enough usable profile text");
  }

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) {
    throw new Error("Job not found");
  }

  // If the new profile is very similar to the stored one, skip the expensive
  // extractCandidateInfo and predictAcceptance calls (saves ~2/3 of AI spend).
  const profileUnchanged =
    !!currentProfileText &&
    isProfileUnchanged(sanitizeCapturedLinkedInText(currentProfileText), cleanedProfileText);

  let name = currentName;
  let headline = currentHeadline;
  let location = currentLocation;

  const extracted = extractIdentityFromLinkedInProfileText(cleanedProfileText);
  if (extracted.name) name = extracted.name;
  if (extracted.headline) headline = extracted.headline;
  if (extracted.location) location = extracted.location;
  const hasDirectName = Boolean(extracted.name);
  const hasDirectHeadline = Boolean(extracted.headline);
  const hasDirectLocation = Boolean(extracted.location);

  if (!profileUnchanged) {
    try {
      const info = await extractCandidateInfo(cleanedProfileText);
      if (!hasDirectName && info.name && info.name !== "Unknown" && info.name.length > 2) name = info.name;
      if (!hasDirectHeadline && info.headline && info.headline.length > 2) headline = info.headline;
      if (!hasDirectLocation && info.location && info.location.length > 2) location = info.location;
    } catch {
      // Keep existing identity fields on parse failures.
    }
  }

  const parsedRole = safeParseJson<ParsedRole | null>(job.parsedRole, null);
  const salary =
    job.salaryMin || job.salaryMax
      ? { min: job.salaryMin ?? 0, max: job.salaryMax ?? 0 }
      : null;

  const scoreData: Record<string, unknown> = profileUnchanged
    ? {}
    : {
        profileTextHash: null,
        matchScore: null,
        matchReason: null,
        scoreBreakdown: null,
        acceptanceScore: null,
        acceptanceReason: null,
      };
  if (parsedRole) {
    // Always re-score — role requirements may have changed even if profile hasn't.
    try {
      const rawBreakdown = await scoreCandidateStructured(cleanedProfileText, parsedRole, salary);
      const breakdown = applyLocationFitOverride(
        rawBreakdown,
        location,
        parsedRole.location,
        parsedRole.location_rules,
        job.isRemote,
      );
      Object.assign(scoreData, deriveUpdateData(breakdown));
      scoreData.profileTextHash = buildScoreCacheKey({
        profileText: cleanedProfileText,
        parsedRole,
        salary,
        jobLocation: job.location,
        isRemote: job.isRemote,
      });
    } catch {
      // Scoring failed — clear any stale cache key so score-all re-scores this
      // candidate on the next run rather than treating the old key as valid.
      scoreData.profileTextHash = null;
    }

    if (!profileUnchanged && cleanedProfileText.length >= 250) {
      try {
        Object.assign(scoreData, buildAcceptanceData(await predictAcceptance(cleanedProfileText, parsedRole, salary)));
      } catch {
        // Acceptance is optional; leave existing fields untouched on failure.
      }
    }
  }

  return {
    name,
    headline,
    location,
    linkedinUrl: normaliseLinkedInUrl(linkedinUrl),
    profileText: cleanedProfileText,
    profileCapturedAt: new Date(),
    ...scoreData,
  };
}

export async function saveCapturedProfileToCandidate(args: {
  jobId: string;
  candidateId: string;
  profileText: string;
  linkedinUrl: string;
}) {
  const { jobId, candidateId, profileText, linkedinUrl } = args;

  const candidate = await prisma.candidate.findUnique({ where: { id: candidateId } });
  if (!candidate || candidate.jobId !== jobId) {
    throw new Error("Candidate not found");
  }

  const data = await buildCapturedCandidateData({
    jobId,
    currentName: candidate.name,
    currentHeadline: candidate.headline,
    currentLocation: candidate.location,
    currentProfileText: candidate.profileText,
    profileText: profileText.trim(),
    linkedinUrl,
  });

  return prisma.candidate.update({
    where: { id: candidateId },
    data: {
      ...data,
      source: "extension",
    },
  });
}

export async function importCapturedLinkedInProfile(args: {
  jobId: string;
  linkedinUrl: string;
  profileText: string;
  source?: string;
}) {
  const { jobId, linkedinUrl, profileText, source = "extension" } = args;
  const cleanUrl = normaliseLinkedInUrl(linkedinUrl);

  // Match by normalised URL to handle variants stored by SerpAPI or manual entry
  // (no www, trailing slash, country-code subdomains, etc.).
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

  const data = await buildCapturedCandidateData({
    jobId,
    currentName: existing?.name ?? "Unknown",
    currentHeadline: existing?.headline ?? null,
    currentLocation: existing?.location ?? null,
    currentProfileText: existing?.profileText ?? null,
    profileText: profileText.trim(),
    linkedinUrl: cleanUrl,
  });

  if (existing) {
    return prisma.candidate.update({
      where: { id: existing.id },
      data: {
        ...data,
        source,
      },
    });
  }

  return prisma.candidate.create({
    data: {
      jobId,
      status: "new",
      source,
      ...data,
    },
  });
}
