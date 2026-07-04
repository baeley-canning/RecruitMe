/**
 * Public endpoints behind invite / password-reset links.
 *
 * GET  /api/auth-tokens/[token] — inspect: is the link valid, what kind, and
 *      what the join/reset page should show (org name / target username).
 * POST /api/auth-tokens/[token] — redeem:
 *      invite: { username, password } → creates the user in the token's org
 *      reset:  { password }           → sets the target user's password
 *
 * No session required (the whole point is the visitor doesn't have one). The
 * token itself is the credential: 256-bit random, single-use, short-lived.
 * Token burn and effect run in ONE transaction with a guarded consume, so a
 * link can never be redeemed twice even under racing submissions.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { getValidToken, consumeToken } from "@/lib/auth-tokens";
import { reportError } from "@/lib/error-reporting";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const t = await getValidToken(token);
  if (!t) return NextResponse.json({ valid: false }, { status: 404 });

  if (t.kind === "invite") {
    const org = t.orgId
      ? await prisma.org.findUnique({ where: { id: t.orgId }, select: { name: true } })
      : null;
    return NextResponse.json({ valid: true, kind: "invite", orgName: org?.name ?? null, role: t.role });
  }

  const user = t.userId
    ? await prisma.user.findUnique({ where: { id: t.userId }, select: { username: true } })
    : null;
  if (!user) return NextResponse.json({ valid: false }, { status: 404 });
  return NextResponse.json({ valid: true, kind: "reset", username: user.username });
}

// Same password policy as the owner-created path (admin/users POST).
const PASSWORD = z.string().min(8, "Password must be at least 8 characters").max(100)
  .regex(/[0-9!@#$%^&*()_\-+=[\]{};':"\\|,.<>/?]/, "Password must contain at least one number or special character");

const RedeemSchema = z.object({
  username: z.string().min(2).max(50).trim().optional(),
  password: PASSWORD,
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const t = await getValidToken(token);
  if (!t) return NextResponse.json({ error: "This link is invalid, expired, or already used." }, { status: 404 });

  const parsed = RedeemSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });

  try {
    if (t.kind === "invite") {
      const username = parsed.data.username;
      if (!username) return NextResponse.json({ error: "Username is required." }, { status: 422 });
      const existing = await prisma.user.findUnique({ where: { username } });
      if (existing) return NextResponse.json({ error: "Username already taken." }, { status: 409 });

      const hashed = await bcrypt.hash(parsed.data.password, 12);
      const created = await prisma.$transaction(async (tx) => {
        if (!(await consumeToken(tx, t.id))) return null;
        return tx.user.create({
          data: { username, password: hashed, role: t.role, orgId: t.orgId },
          select: { id: true, username: true },
        });
      });
      if (!created) return NextResponse.json({ error: "This link was just used." }, { status: 409 });
      return NextResponse.json({ ok: true, username: created.username }, { status: 201 });
    }

    // reset
    if (!t.userId) return NextResponse.json({ error: "This link is invalid." }, { status: 404 });
    const hashed = await bcrypt.hash(parsed.data.password, 12);
    const updated = await prisma.$transaction(async (tx) => {
      if (!(await consumeToken(tx, t.id))) return null;
      return tx.user.update({
        where: { id: t.userId as string },
        data: { password: hashed },
        select: { username: true },
      });
    });
    if (!updated) return NextResponse.json({ error: "This link was just used." }, { status: 409 });
    return NextResponse.json({ ok: true, username: updated.username });
  } catch (err) {
    reportError(err, { route: "auth-tokens:redeem", kind: t.kind });
    return NextResponse.json({ error: "Something went wrong — ask for a fresh link." }, { status: 500 });
  }
}
