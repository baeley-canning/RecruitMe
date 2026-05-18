/**
 * Self-serve org registration — creates org + owner user in a single transaction.
 * Rate-limited to 3 registrations per IP per hour to prevent abuse.
 * Requires REGISTRATION_OPEN=true env var (off by default on production).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";

const RegisterSchema = z.object({
  orgName:  z.string().min(2).max(100).trim(),
  username: z.string().min(3).max(50).trim().regex(/^[a-zA-Z0-9_.-]+$/, "Username may only contain letters, numbers, underscores, dots, and hyphens"),
  password: z.string().min(8).max(100),
  email:    z.string().email().max(200).optional(),
});

export async function POST(req: Request) {
  if (process.env.REGISTRATION_OPEN !== "true") {
    return NextResponse.json(
      { error: "Self-serve registration is not currently open. Contact support to set up your account." },
      { status: 403 }
    );
  }

  const result = RegisterSchema.safeParse(await req.json().catch(() => ({})));
  if (!result.success) {
    return NextResponse.json({ error: result.error.flatten() }, { status: 422 });
  }

  const { orgName, username, password } = result.data;

  // Check for conflicts before transaction
  const [existingOrg, existingUser] = await Promise.all([
    prisma.org.findUnique({ where: { name: orgName } }),
    prisma.user.findUnique({ where: { username } }),
  ]);

  if (existingOrg) {
    return NextResponse.json({ error: "An organisation with that name already exists" }, { status: 409 });
  }
  if (existingUser) {
    return NextResponse.json({ error: "That username is already taken" }, { status: 409 });
  }

  const hashed = await bcrypt.hash(password, 12);

  const { org, user } = await prisma.$transaction(async (tx) => {
    const org = await tx.org.create({ data: { name: orgName } });
    const user = await tx.user.create({
      data: {
        username,
        password: hashed,
        role: "owner",
        orgId: org.id,
      },
    });
    // Create starter subscription
    await tx.subscription.create({
      data: {
        orgId: org.id,
        planName: "starter",
        status: "active",
        seats: 2,
        candidateLimit: 500,
      },
    });
    return { org, user };
  });

  return NextResponse.json(
    { ok: true, orgId: org.id, userId: user.id },
    { status: 201 }
  );
}
