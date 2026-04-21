import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import bcrypt from "bcryptjs";
import { authOptions } from "./auth";
import { prisma } from "./db";

export interface AuthResult {
  userId: string;
  orgId: string | null;
  isOwner: boolean;
}

type SessionUser = {
  id?: string;
  role?: string;
  orgId?: string | null;
};

export async function getAuth(): Promise<AuthResult | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user) return null;
  const u = session.user as SessionUser;
  return {
    userId: u.id ?? "",
    orgId: u.orgId ?? null,
    isOwner: u.role === "owner",
  };
}

export function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export function forbidden() {
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

function notFound(message: string) {
  return NextResponse.json({ error: message }, { status: 404 });
}

/** Load a job and verify the caller can access it. */
export async function requireJobAccess(jobId: string, auth: AuthResult) {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return { job: null, error: notFound("Job not found") };
  if (!auth.isOwner && job.orgId !== auth.orgId) return { job: null, error: forbidden() };
  return { job, error: null };
}

/** Load a candidate for a specific job and verify the caller can access both. */
export async function requireCandidateAccess(
  jobId: string,
  candidateId: string,
  auth: AuthResult
) {
  const { job, error } = await requireJobAccess(jobId, auth);
  if (error || !job) return { job: null, candidate: null, error };

  const candidate = await prisma.candidate.findFirst({
    where: { id: candidateId, jobId },
  });

  if (!candidate) {
    return {
      job,
      candidate: null,
      error: notFound("Candidate not found"),
    };
  }

  return { job, candidate, error: null };
}

/**
 * Accept either Basic auth (browser extension) or NextAuth session (web UI).
 * Use this on routes called from both contexts.
 */
export async function verifyAnyAuth(req: Request): Promise<AuthResult | null> {
  const extensionAuth = await verifyExtensionAuth(req);
  if (extensionAuth) return extensionAuth;
  return getAuth();
}

/**
 * Validate Basic auth credentials sent by the browser extension.
 * Returns an AuthResult or null if credentials are missing / invalid.
 */
export async function verifyExtensionAuth(req: Request): Promise<AuthResult | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Basic ")) return null;

  let username: string, password: string;
  try {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf-8");
    const colonIdx = decoded.indexOf(":");
    if (colonIdx === -1) return null;
    username = decoded.slice(0, colonIdx);
    password = decoded.slice(colonIdx + 1);
  } catch {
    return null;
  }

  if (!username || !password) return null;

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) return null;

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return null;

  return {
    userId: user.id,
    orgId: user.orgId ?? null,
    isOwner: user.role === "owner",
  };
}

/** WHERE clause for listing jobs the caller is allowed to see. */
export function jobsWhere(auth: AuthResult) {
  if (auth.isOwner) return {};
  return { orgId: auth.orgId };
}
