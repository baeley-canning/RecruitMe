/**
 * Background maintenance tasks — run periodically to prevent table bloat.
 * Called from a Next.js API route on a schedule (or at startup with a cooldown).
 */
import { prisma } from "./db";

const USAGE_EVENT_RETENTION_DAYS = 90;
const LOGIN_ATTEMPT_CLEANUP_DAYS = 1; // expired attempts can be purged daily

/**
 * Delete UsageEvents older than USAGE_EVENT_RETENTION_DAYS.
 * Keeps the table lean for analytics queries. Historical data beyond 90 days
 * is rarely needed and grows unbounded otherwise.
 */
export async function purgeOldUsageEvents(): Promise<{ deleted: number }> {
  const cutoff = new Date(Date.now() - USAGE_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const result = await prisma.usageEvent.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  return { deleted: result.count };
}

/**
 * Delete expired LoginAttempt rows. Rows are window-bounded (15 min);
 * once expired they are safe to remove. Without cleanup the table grows
 * unbounded at the rate of failed login attempts.
 */
export async function purgeExpiredLoginAttempts(): Promise<{ deleted: number }> {
  const cutoff = new Date(Date.now() - LOGIN_ATTEMPT_CLEANUP_DAYS * 24 * 60 * 60 * 1000);
  const result = await prisma.loginAttempt.deleteMany({
    where: { resetAt: { lt: cutoff } },
  });
  return { deleted: result.count };
}

/**
 * Run all maintenance tasks. Safe to call on any schedule.
 */
export async function runMaintenance(): Promise<void> {
  try {
    const [usage, attempts] = await Promise.all([
      purgeOldUsageEvents(),
      purgeExpiredLoginAttempts(),
    ]);
    console.log(`[maintenance] purged ${usage.deleted} usage events, ${attempts.deleted} login attempts`);
  } catch (err) {
    console.error("[maintenance] failed:", err);
  }
}
