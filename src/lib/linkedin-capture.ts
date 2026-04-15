import { prisma } from "./db";
import { deriveUpdateData } from "./score-utils";
import {
  extractCandidateInfo,
  predictAcceptance,
  scoreCandidateStructured,
  type ParsedRole,
} from "./ai";
import { safeParseJson } from "./utils";

export const LINKEDIN_EXTENSION_SESSION_KEY = "LINKEDIN_EXTENSION_PENDING_CAPTURE_V1";

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

export function normaliseLinkedInUrl(raw: string): string {
  const match = raw.match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  const slug = match ? match[1] : raw.replace(/[?#].*$/, "").replace(/\/$/, "");
  return `https://www.linkedin.com/in/${slug}`;
}

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
  profileText: string;
  linkedinUrl: string;
}) {
  const { jobId, currentName, currentHeadline, currentLocation, profileText, linkedinUrl } = args;

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) {
    throw new Error("Job not found");
  }

  let name = currentName;
  let headline = currentHeadline;
  let location = currentLocation;

  try {
    const info = await extractCandidateInfo(profileText);
    if (info.name && info.name !== "Unknown" && info.name.length > 2) name = info.name;
    if (info.headline && info.headline.length > 2) headline = info.headline;
    if (info.location && info.location.length > 2) location = info.location;
  } catch {
    // Keep existing identity fields on parse failures.
  }

  const parsedRole = safeParseJson<ParsedRole | null>(job.parsedRole, null);
  const salary =
    job.salaryMin || job.salaryMax
      ? { min: job.salaryMin ?? 0, max: job.salaryMax ?? 0 }
      : null;

  const scoreData: Record<string, unknown> = {};
  if (parsedRole) {
    try {
      const breakdown = await scoreCandidateStructured(profileText, parsedRole, salary);
      Object.assign(scoreData, deriveUpdateData(breakdown));
    } catch {
      // Keep candidate unscored if the model call fails.
    }

    if (profileText.length >= 250) {
      try {
        Object.assign(scoreData, buildAcceptanceData(await predictAcceptance(profileText, parsedRole, salary)));
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
    profileText,
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
    profileText: profileText.trim(),
    linkedinUrl,
  });

  return prisma.candidate.update({
    where: { id: candidateId },
    data,
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

export async function getPendingExtensionCaptureSession(): Promise<ExtensionCaptureSession | null> {
  const row = await prisma.setting.findUnique({
    where: { key: LINKEDIN_EXTENSION_SESSION_KEY },
  });
  if (!row?.value) return null;

  try {
    const session = JSON.parse(row.value) as ExtensionCaptureSession;
    if (!session?.sessionId || !session?.candidateId || !session?.linkedinUrl) return null;

    const ageMs = Date.now() - new Date(session.updatedAt || session.createdAt).getTime();
    if (ageMs > 15 * 60 * 1000) {
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

