/**
 * Lightweight cross-process lock backed by the existing `Setting` table.
 *
 * Use case: a cron-driven endpoint that must not run concurrently with
 * itself (Railway can retry; the user can hit it manually mid-cron; etc).
 *
 * Why not `pg_try_advisory_lock`? Postgres advisory locks are session-
 * scoped, and Prisma's connection pool means a follow-up call may use a
 * different connection — the lock would silently vanish. Wrapping the
 * whole sync in a single `$transaction` would solve that but produces
 * multi-minute write transactions, which block vacuum and hold row
 * locks for longer than is healthy.
 *
 * Instead: claim a row in the `Setting` table. Stale locks are auto-
 * reclaimed after `staleMs` so a crashed worker doesn't wedge the lock
 * permanently. The release is best-effort — a missed release just means
 * the next attempt waits up to `staleMs` for the row to age out.
 */

import { prisma } from "./db";

const DEFAULT_STALE_MS = 15 * 60 * 1000;

/**
 * Try to claim a named lock. Returns `true` if claimed, `false` if a
 * non-stale lock is already held by another worker.
 *
 * @param staleMs how long the lock can sit without a heartbeat before another
 *   worker is allowed to reclaim it. Defaults to {@link DEFAULT_STALE_MS}
 *   (15 min). Long-running jobs that can exceed 15 min (e.g. a full
 *   sync-contact-sheet pass over a large sheet) MUST pass a higher value
 *   AND call {@link refreshLock} periodically — otherwise a sibling worker
 *   may reclaim mid-flight and run a duplicate pass.
 */
export async function tryAcquireLock(name: string, staleMs = DEFAULT_STALE_MS): Promise<boolean> {
  const key = `lock:${name}`;
  const now = new Date();
  const staleBefore = new Date(now.getTime() - staleMs);

  // Path 1: claim an existing row if it's free ("") or stale.
  const updated = await prisma.setting.updateMany({
    where: { key, OR: [{ value: "" }, { updatedAt: { lt: staleBefore } }] },
    data: { value: now.toISOString() },
  });
  if (updated.count === 1) return true;

  // Path 2: row doesn't exist yet — create it. The @id unique constraint
  // catches the race where two workers hit Path 2 concurrently.
  try {
    await prisma.setting.create({ data: { key, value: now.toISOString() } });
    return true;
  } catch {
    return false;
  }
}

/** Release a previously-acquired lock. Best-effort; safe to call on a
 *  lock you didn't acquire (no-op). */
export async function releaseLock(name: string): Promise<void> {
  const key = `lock:${name}`;
  await prisma.setting.update({ where: { key }, data: { value: "" } }).catch(() => {});
}

/**
 * Heartbeat: re-stamp the lock's timestamp so siblings don't reclaim it
 * mid-task. Long-running jobs should call this periodically (e.g. every
 * `staleMs / 3`) while they hold the lock.
 *
 * Best-effort: a failed update (transient DB blip) is swallowed — the next
 * heartbeat will reset the clock. If the lock row has been reclaimed by
 * another worker we still rewrite the value here; that's intentional and
 * mirrors the "best-effort release" stance. Locking is advisory, not a
 * hard mutex.
 */
export async function refreshLock(name: string): Promise<void> {
  const key = `lock:${name}`;
  const now = new Date();
  // updateMany rather than update so a missing row is a no-op rather than
  // a P2025 throw (caller may have already released, or the row was
  // garbage-collected by an admin clear).
  await prisma.setting
    .updateMany({ where: { key }, data: { value: now.toISOString() } })
    .catch(() => {});
}

/** Convenience wrapper: acquire, run, release. Throws `LockBusyError` if
 *  the lock is held. */
export async function withLock<T>(name: string, fn: () => Promise<T>, staleMs?: number): Promise<T> {
  const acquired = await tryAcquireLock(name, staleMs);
  if (!acquired) throw new LockBusyError(name);
  try {
    return await fn();
  } finally {
    await releaseLock(name);
  }
}

export class LockBusyError extends Error {
  constructor(public readonly lockName: string) {
    super(`Lock "${lockName}" is already held by another worker`);
    this.name = "LockBusyError";
  }
}
