/**
 * Single-use auth-token links: invites (a new user sets their own password —
 * the admin never knows it) and password resets (a locked-out user recovers
 * without the admin typing a replacement into chat).
 *
 * Deliberately email-free: the admin generates a LINK and hands it over
 * out-of-band (Slack/SMS/in person). When a transactional-email provider is
 * added later, "send the link" becomes one call on top of these exact
 * primitives — nothing here changes.
 *
 * Security model:
 *  - 256-bit random token, present ONLY in the URL; the DB stores sha256.
 *  - Single-use: consumption sets usedAt via a guarded updateMany
 *    (WHERE usedAt IS NULL), so two racing submissions can't both redeem.
 *  - Short expiries: invites 7 days, resets 2 hours.
 */

import { createHash, randomBytes } from "node:crypto";
import { prisma } from "./db";

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const RESET_TTL_MS = 2 * 60 * 60 * 1000;

export type AuthTokenKind = "invite" | "reset";

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Base URL for generated links: explicit env wins (Railway sets NEXTAUTH_URL);
 *  falls back to the request's own origin for local dev. */
export function linkBaseUrl(req: Request): string {
  const env = process.env.NEXTAUTH_URL?.replace(/\/$/, "");
  if (env) return env;
  return new URL(req.url).origin;
}

export async function createInviteToken(args: {
  orgId: string | null;
  role: "user" | "owner";
  createdBy: string | null;
}): Promise<{ raw: string; expiresAt: Date }> {
  const raw = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  await prisma.authToken.create({
    data: {
      kind: "invite",
      tokenHash: hashToken(raw),
      orgId: args.orgId,
      role: args.role,
      createdBy: args.createdBy,
      expiresAt,
    },
  });
  return { raw, expiresAt };
}

export async function createResetToken(args: {
  userId: string;
  createdBy: string | null;
}): Promise<{ raw: string; expiresAt: Date }> {
  const raw = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + RESET_TTL_MS);
  await prisma.authToken.create({
    data: {
      kind: "reset",
      tokenHash: hashToken(raw),
      userId: args.userId,
      createdBy: args.createdBy,
      expiresAt,
    },
  });
  return { raw, expiresAt };
}

export interface ValidAuthToken {
  id: string;
  kind: AuthTokenKind;
  orgId: string | null;
  role: string;
  userId: string | null;
}

/** Look up a raw token; null unless it exists, is unused, and is unexpired. */
export async function getValidToken(raw: string): Promise<ValidAuthToken | null> {
  if (!raw || raw.length < 20 || raw.length > 200) return null;
  const row = await prisma.authToken.findUnique({
    where: { tokenHash: hashToken(raw) },
    select: { id: true, kind: true, orgId: true, role: true, userId: true, expiresAt: true, usedAt: true },
  });
  if (!row) return null;
  if (row.usedAt) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;
  return { id: row.id, kind: row.kind as AuthTokenKind, orgId: row.orgId, role: row.role, userId: row.userId };
}

/**
 * Atomically mark a token used. Returns false if someone else won the race
 * (or it was already consumed) — the caller must then NOT apply the effect.
 * Run INSIDE the same transaction as the effect (user create / password set)
 * so token-burn and effect commit or roll back together.
 */
export async function consumeToken(
  tx: Pick<typeof prisma, "authToken">,
  tokenId: string,
): Promise<boolean> {
  const r = await tx.authToken.updateMany({
    where: { id: tokenId, usedAt: null },
    data: { usedAt: new Date() },
  });
  return r.count === 1;
}
