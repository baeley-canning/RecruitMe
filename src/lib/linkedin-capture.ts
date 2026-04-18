import { prisma } from "./db";
import { applyLocationFitOverride, deriveUpdateData } from "./score-utils";
import {
  extractCandidateInfo,
  predictAcceptance,
  scoreCandidateStructured,
  type ParsedRole,
} from "./ai";
import { safeParseJson } from "./utils";
import { isProfileUnchanged } from "./talent-pool";
import { normaliseLinkedInUrl } from "./linkedin";

export { normaliseLinkedInUrl } from "./linkedin";

// Legacy single-session key (kept for reference only; new code uses the queue key).
export const LINKEDIN_EXTENSION_SESSION_KEY = "LINKEDIN_EXTENSION_PENDING_CAPTURE_V1";
// Multi-session queue — stores ExtensionCaptureSession[] as JSON.
export const LINKEDIN_EXTENSION_QUEUE_KEY = "LINKEDIN_EXTENSION_QUEUE_V1";

const SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes

export type ExtensionCaptureStatus = "pending" | "processing" | "completed" | "error";

export interface ExtensionCaptureSession {
  sessionId: string;
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

function nowIso() {
  return new Date().toISOString();
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

// ---------------------------------------------------------------------------
// Multi-session queue helpers
// ---------------------------------------------------------------------------

async function readSessionQueue(): Promise<ExtensionCaptureSession[]> {
  const row = await prisma.setting.findUnique({ where: { key: LINKEDIN_EXTENSION_QUEUE_KEY } });
  if (!row?.value) return [];
  try {
    const data = JSON.parse(row.value) as unknown;
    if (!Array.isArray(data)) return [];
    return data as ExtensionCaptureSession[];
  } catch {
    return [];
  }
}

async function writeSessionQueue(sessions: ExtensionCaptureSession[]): Promise<void> {
  const now = Date.now();
  const active = sessions.filter(
    (s) => now - new Date(s.updatedAt || s.createdAt).getTime() <= SESSION_TTL_MS
  );

  if (active.length === 0) {
    await prisma.setting.delete({ where: { key: LINKEDIN_EXTENSION_QUEUE_KEY } }).catch(() => {});
    return;
  }

  await prisma.setting.upsert({
    where: { key: LINKEDIN_EXTENSION_QUEUE_KEY },
    update: { value: JSON.stringify(active) },
    create: { key: LINKEDIN_EXTENSION_QUEUE_KEY, value: JSON.stringify(active) },
  });
}

/** Returns all non-expired sessions currently in the queue. */
export async function getSessionQueue(): Promise<ExtensionCaptureSession[]> {
  const sessions = await readSessionQueue();
  const now = Date.now();
  const active = sessions.filter(
    (s) => now - new Date(s.updatedAt || s.createdAt).getTime() <= SESSION_TTL_MS
  );
  if (active.length !== sessions.length) {
    await writeSessionQueue(active);
  }
  return active;
}

/** Add (or replace an existing session for the same candidateId) in the queue. */
export async function addSessionToQueue(session: ExtensionCaptureSession): Promise<void> {
  const queue = await getSessionQueue();
  const filtered = queue.filter((s) => s.candidateId !== session.candidateId);
  await writeSessionQueue([...filtered, session]);
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
  const queue = await getSessionQueue();
  const idx = queue.findIndex((s) => s.sessionId === patch.sessionId);
  if (idx === -1) return null;

  const updated: ExtensionCaptureSession = { ...queue[idx], ...patch, updatedAt: nowIso() };
  queue[idx] = updated;
  await writeSessionQueue(queue);
  return updated;
}

/** Remove a session from the queue by sessionId. */
export async function removeSessionFromQueue(sessionId: string): Promise<void> {
  const queue = await getSessionQueue();
  await writeSessionQueue(queue.filter((s) => s.sessionId !== sessionId));
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

  if (!profileUnchanged) {
    try {
      const info = await extractCandidateInfo(cleanedProfileText);
      if (info.name && info.name !== "Unknown" && info.name.length > 2) name = info.name;
      if (info.headline && info.headline.length > 2) headline = info.headline;
      if (info.location && info.location.length > 2) location = info.location;
    } catch {
      // Keep existing identity fields on parse failures.
    }
  }

  const parsedRole = safeParseJson<ParsedRole | null>(job.parsedRole, null);
  const salary =
    job.salaryMin || job.salaryMax
      ? { min: job.salaryMin ?? 0, max: job.salaryMax ?? 0 }
      : null;

  const scoreData: Record<string, unknown> = {};
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
    } catch {
      // Keep candidate unscored if the model call fails.
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

// ---------------------------------------------------------------------------
// Legacy single-session helpers (kept for backward compatibility during migration)
// ---------------------------------------------------------------------------

export async function getPendingExtensionCaptureSession(): Promise<ExtensionCaptureSession | null> {
  const row = await prisma.setting.findUnique({
    where: { key: LINKEDIN_EXTENSION_SESSION_KEY },
  });
  if (!row?.value) return null;

  try {
    const session = JSON.parse(row.value) as ExtensionCaptureSession;
    if (!session?.sessionId || !session?.candidateId || !session?.linkedinUrl) return null;

    const ageMs = Date.now() - new Date(session.updatedAt || session.createdAt).getTime();
    if (ageMs > SESSION_TTL_MS) {
      await clearPendingExtensionCaptureSession();
      return null;
    }

    return session;
  } catch {
    return null;
  }
}

export async function setPendingExtensionCaptureSession(session: ExtensionCaptureSession) {
  await prisma.setting.upsert({
    where: { key: LINKEDIN_EXTENSION_SESSION_KEY },
    update: { value: JSON.stringify(session) },
    create: { key: LINKEDIN_EXTENSION_SESSION_KEY, value: JSON.stringify(session) },
  });
}

export async function updatePendingExtensionCaptureSession(
  patch: Partial<ExtensionCaptureSession> & Pick<ExtensionCaptureSession, "sessionId">
) {
  const session = await getPendingExtensionCaptureSession();
  if (!session || session.sessionId !== patch.sessionId) return null;

  const next: ExtensionCaptureSession = {
    ...session,
    ...patch,
    updatedAt: nowIso(),
  };
  await setPendingExtensionCaptureSession(next);
  return next;
}

export async function clearPendingExtensionCaptureSession() {
  await prisma.setting.delete({ where: { key: LINKEDIN_EXTENSION_SESSION_KEY } }).catch(() => {});
}
