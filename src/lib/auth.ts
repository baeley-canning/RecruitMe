import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { prisma } from "./db";
import bcrypt from "bcryptjs";
import { ensureDefaultOrg } from "./org";

// Warn at module load if NEXTAUTH_SECRET is missing — full validation at runtime in authorize().
// (Can't throw at module load because Next.js imports this during build without secrets.)
if (process.env.NODE_ENV === "production" && !process.env.NEXTAUTH_SECRET?.trim()) {
  console.error("NEXTAUTH_SECRET is not set — sessions will not work. Set it in Railway Variables.");
}

// DB-backed brute-force protection — survives server restarts and horizontal scaling.
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;

// In-process fallback. The DB is the source of truth across replicas, but if
// Postgres is degraded we still need to rate-limit — otherwise a flood lands
// during exactly the failure mode where everything else is slow. Bounded
// LRU-style: cap entries so a flood of unique usernames can't OOM the worker.
const IN_PROC_CAP = 5_000;
const inProcAttempts = new Map<string, { count: number; resetAt: number }>();

function pruneInProcExpired() {
  const now = Date.now();
  for (const [key, entry] of inProcAttempts) {
    if (entry.resetAt <= now) inProcAttempts.delete(key);
  }
  if (inProcAttempts.size > IN_PROC_CAP) {
    // Evict oldest first (insertion order on Map iteration).
    const overflow = inProcAttempts.size - IN_PROC_CAP;
    const it = inProcAttempts.keys();
    for (let i = 0; i < overflow; i++) {
      const next = it.next();
      if (next.done) break;
      inProcAttempts.delete(next.value);
    }
  }
}

function bumpInProc(key: string) {
  pruneInProcExpired();
  const now = Date.now();
  const existing = inProcAttempts.get(key);
  if (existing && existing.resetAt > now) {
    existing.count += 1;
  } else {
    inProcAttempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
  }
}

function inProcLockState(key: string): { locked: boolean; minsLeft: number } {
  const entry = inProcAttempts.get(key);
  if (!entry) return { locked: false, minsLeft: 0 };
  if (entry.resetAt <= Date.now()) {
    inProcAttempts.delete(key);
    return { locked: false, minsLeft: 0 };
  }
  if (entry.count >= MAX_ATTEMPTS) {
    return { locked: true, minsLeft: Math.ceil((entry.resetAt - Date.now()) / 60000) };
  }
  return { locked: false, minsLeft: 0 };
}

export async function recordLoginFailure(key: string): Promise<void> {
  const now = new Date();
  const resetAt = new Date(now.getTime() + WINDOW_MS);
  try {
    await prisma.loginAttempt.upsert({
      where: { key },
      update: { count: { increment: 1 } },
      create: { key, count: 1, resetAt },
    });
  } catch {
    // DB write failed — fall back to in-process counter so the brute-force
    // ceiling still applies during a Postgres degradation.
    bumpInProc(key);
    return;
  }
  // Mirror to in-process so concurrent checks during this request stay
  // consistent. The DB remains source of truth across replicas.
  bumpInProc(key);
}

export async function clearLoginFailures(key: string): Promise<void> {
  inProcAttempts.delete(key);
  try {
    await prisma.loginAttempt.deleteMany({ where: { key } });
  } catch { /* non-fatal */ }
}

export async function checkLoginLocked(key: string): Promise<{ locked: boolean; minsLeft: number }> {
  // Local-first check: even when the DB is healthy, if this process has
  // already seen MAX_ATTEMPTS, lock immediately without round-tripping.
  const local = inProcLockState(key);
  if (local.locked) return local;

  try {
    const entry = await prisma.loginAttempt.findUnique({ where: { key } });
    if (!entry) return { locked: false, minsLeft: 0 };
    if (new Date() >= entry.resetAt) {
      await prisma.loginAttempt.deleteMany({ where: { key } });
      return { locked: false, minsLeft: 0 };
    }
    if (entry.count >= MAX_ATTEMPTS) {
      const minsLeft = Math.ceil((entry.resetAt.getTime() - Date.now()) / 60000);
      return { locked: true, minsLeft };
    }
    return { locked: false, minsLeft: 0 };
  } catch {
    // DB read failed — fall back to in-process. This fails CLOSED in the
    // sense that any prior in-process strikes still apply; we don't reset
    // the counter on a DB blip.
    return local;
  }
}

const authUrl =
  process.env.NEXTAUTH_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  process.env.RAILWAY_PUBLIC_DOMAIN ||
  "";

const useSecureCookies =
  authUrl.startsWith("https://") ||
  Boolean(process.env.RAILWAY_PUBLIC_DOMAIN && !authUrl.startsWith("http://"));

export const authOptions: NextAuthOptions = {
  secret: process.env.NEXTAUTH_SECRET,
  useSecureCookies,
  providers: [
    CredentialsProvider({
      name: "credentials",
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        // Runtime secret validation — catches misconfigured deployments immediately.
        const secret = process.env.NEXTAUTH_SECRET?.trim();
        if (!secret || secret.length < 32) {
          throw new Error("Server misconfiguration: NEXTAUTH_SECRET must be set and ≥32 chars.");
        }

        if (!credentials?.username || !credentials?.password) return null;

        const key = credentials.username.toLowerCase().trim();

        const { locked, minsLeft } = await checkLoginLocked(key);
        if (locked) {
          throw new Error(`Too many failed attempts — try again in ${minsLeft} minute${minsLeft !== 1 ? "s" : ""}.`);
        }

        let user = await prisma.user.findUnique({
          where: { username: credentials.username },
        });

        if (!user) {
          // Count failed attempt for non-existent usernames too (prevents enumeration timing)
          await recordLoginFailure(key);
          return null;
        }

        const valid = await bcrypt.compare(credentials.password, user.password);
        if (!valid) {
          await recordLoginFailure(key);
          return null;
        }

        await clearLoginFailures(key);

        if (user.role !== "owner" && !user.orgId) {
          const defaultOrg = await ensureDefaultOrg();
          user = await prisma.user.update({
            where: { id: user.id },
            data: { orgId: defaultOrg.id },
          });
        }

        return {
          id: user.id,
          name: user.username,
          role: user.role,
          orgId: user.orgId ?? null,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        const authUser = user as { id?: string; role?: string; orgId?: string | null };
        token.role = authUser.role;
        token.id = authUser.id;
        token.orgId = authUser.orgId ?? null;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        const u = session.user as Record<string, unknown>;
        u.role  = token.role;
        u.id    = token.id;
        u.orgId = token.orgId ?? null;
      }
      return session;
    },
  },
  pages: {
    signIn: "/login",
  },
  session: {
    strategy: "jwt",
    maxAge: 12 * 60 * 60, // 12 hours — reduces window of compromise for stolen tokens
  },
};
