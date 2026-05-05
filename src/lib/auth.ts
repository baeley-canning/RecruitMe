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

export async function recordLoginFailure(key: string): Promise<void> {
  const now = new Date();
  const resetAt = new Date(now.getTime() + WINDOW_MS);
  try {
    await prisma.loginAttempt.upsert({
      where: { key },
      update: { count: { increment: 1 } },
      create: { key, count: 1, resetAt },
    });
  } catch { /* non-fatal */ }
}

export async function clearLoginFailures(key: string): Promise<void> {
  try {
    await prisma.loginAttempt.deleteMany({ where: { key } });
  } catch { /* non-fatal */ }
}

export async function checkLoginLocked(key: string): Promise<{ locked: boolean; minsLeft: number }> {
  try {
    const entry = await prisma.loginAttempt.findUnique({ where: { key } });
    if (!entry) return { locked: false, minsLeft: 0 };
    // Expired window — clean up and allow
    if (new Date() >= entry.resetAt) {
      await prisma.loginAttempt.deleteMany({ where: { key } });
      return { locked: false, minsLeft: 0 };
    }
    if (entry.count >= MAX_ATTEMPTS) {
      const minsLeft = Math.ceil((entry.resetAt.getTime() - Date.now()) / 60000);
      return { locked: true, minsLeft };
    }
  } catch { /* non-fatal — fail open so a DB outage doesn't lock everyone out */ }
  return { locked: false, minsLeft: 0 };
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
