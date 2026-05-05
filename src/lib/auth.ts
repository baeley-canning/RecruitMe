import { prisma } from "./db";

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

// authOptions has been removed — configuration now lives in src/auth.ts (next-auth v5).
// This file retains only the brute-force login protection helpers used by both the
// NextAuth authorize() callback (src/auth.ts) and the extension Basic auth path (session.ts).
