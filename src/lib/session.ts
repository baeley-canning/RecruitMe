import crypto from "crypto";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import bcrypt from "bcryptjs";
import { authOptions, checkLoginLocked, recordLoginFailure, clearLoginFailures } from "./auth";
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

// ─── Route handler wrappers ────────────────────────────────────────────────
// These reduce ~6 lines of auth boilerplate per route to a single composition.
// Use sparingly — they're for the common case where a route just needs auth +
// optional job/candidate access. Routes with bespoke flows (the search-async
// dispatcher, the public shortlist endpoint) should keep their explicit guards.

type RouteHandler<P, R> = (args: { auth: AuthResult; req: Request; params: P }) => Promise<R>;

/** Wrap a handler to require an authenticated session. */
export function withAuth<P, R>(handler: RouteHandler<P, R>) {
  return async (req: Request, ctx: { params: Promise<P> }) => {
    const auth = await getAuth();
    if (!auth) return unauthorized();
    const params = await ctx.params;
    return handler({ auth, req, params });
  };
}

/** Wrap a handler to require auth + ownership of {id} (a Job ID). */
export function withJobAuth<R>(
  handler: (args: {
    auth: AuthResult;
    req: Request;
    params: { id: string };
    job: NonNullable<Awaited<ReturnType<typeof requireJobAccess>>["job"]>;
  }) => Promise<R>,
) {
  return async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const auth = await getAuth();
    if (!auth) return unauthorized();
    const params = await ctx.params;
    const { job, error } = await requireJobAccess(params.id, auth);
    if (error || !job) return error;
    return handler({ auth, req, params, job });
  };
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

  // Same brute-force protection as the NextAuth login path. checkLoginLocked
  // now has an in-process fallback when the DB is unreachable, so we trust
  // its return value and don't swallow exceptions — failing closed for the
  // extension is acceptable (the extension already retries) and prevents
  // the brute-force ceiling from disappearing during a Postgres blip.
  const key = `ext:${username.toLowerCase().trim()}`;
  const { locked } = await checkLoginLocked(key).catch(() => ({ locked: true, minsLeft: 15 }));
  if (locked) return null;

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) {
    await recordLoginFailure(key).catch(() => {});
    return null;
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    await recordLoginFailure(key).catch(() => {});
    return null;
  }

  await clearLoginFailures(key).catch(() => {});
  return {
    userId: user.id,
    orgId: user.orgId ?? null,
    isOwner: user.role === "owner",
  };
}

/**
 * Result of a successful headless-scraper bearer-token auth. Deliberately
 * smaller than AuthResult — there's no User behind a scraper token, just an
 * org scope (null = owner-scope, may ingest into any org) and the token row's
 * id for audit/troubleshooting.
 */
export interface ScraperAuthResult {
  orgId: string | null;
  tokenId: string;
}

/**
 * Validate the `Authorization: Bearer <token>` header sent by the user's
 * own headless scraper (mini-PC pulling their own candidate data). Returns
 * a ScraperAuthResult or null if the token is missing / unknown / revoked /
 * expired.
 *
 * The plaintext token is never stored — we look up by sha256 hex of it,
 * matching the hash written by scripts/create-scraper-token.mjs.
 */
export async function verifyScraperAuth(req: Request): Promise<ScraperAuthResult | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const token = authHeader.slice(7).trim();
  if (!token) return null;

  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  const row = await prisma.scraperApiToken.findUnique({ where: { tokenHash } });
  if (!row) return null;
  if (row.revokedAt != null) return null;
  if (row.expiresAt != null && row.expiresAt < new Date()) return null;

  // Fire-and-forget last-used stamp — don't block the request on it, and
  // don't let a failed write reject an otherwise valid token.
  prisma.scraperApiToken
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  return { orgId: row.orgId, tokenId: row.id };
}

/** WHERE clause for listing jobs the caller is allowed to see. */
export function jobsWhere(auth: AuthResult) {
  if (auth.isOwner) return {};
  return { orgId: auth.orgId };
}

/**
 * Jobs for the sidebar, ordered by most-recent activity descending.
 * "Activity" = the latest of the Job's own updatedAt and the latest
 * Candidate.updatedAt on the job — so adding/scoring/editing a candidate
 * bubbles the job to the top, not just edits to the job itself.
 */
export async function getSidebarJobs(auth: AuthResult) {
  const rows = await prisma.job.findMany({
    where: jobsWhere(auth),
    select: {
      id: true,
      title: true,
      company: true,
      status: true,
      updatedAt: true,
      _count: { select: { candidates: true } },
      candidates: {
        orderBy: { updatedAt: "desc" },
        take: 1,
        select: { updatedAt: true },
      },
    },
  });

  return rows
    .map((j) => {
      const latestCand = j.candidates[0]?.updatedAt;
      const activityAt = latestCand && latestCand > j.updatedAt ? latestCand : j.updatedAt;
      return { id: j.id, title: j.title, company: j.company, status: j.status, _count: j._count, activityAt };
    })
    .sort((a, b) => b.activityAt.getTime() - a.activityAt.getTime())
    .map(({ activityAt: _a, ...rest }) => rest);
}
