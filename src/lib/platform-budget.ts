/**
 * A daily ceiling on what the scraper may do to each platform.
 *
 * Enforced where jobs are CLAIMED, because that is the only chokepoint the
 * worker cannot route around. Whatever state the worker gets into — a routing
 * bug that makes every job fail in 4s, a retry loop against an MFA wall — it can
 * only ever act on what the API hands it.
 *
 * This exists because both of those happened in one day: 33 SEEK login attempts,
 * and a fetch loop running six times faster than intended, which got the owner's
 * LinkedIn account flagged. Each was caught by a human watching logs. That is not
 * a control.
 *
 * Set budgets with SCRAPE_DAILY_BUDGETS, e.g. "seek=250,linkedin=0".
 * A platform with no entry is unlimited (nothing changes until you say so);
 * a platform set to 0 is genuinely stopped — that is how LinkedIn automation is
 * switched off on a box without shipping code.
 */

export interface BudgetedJob {
  id: string;
  platform: string;
}

export interface BudgetResult<T extends BudgetedJob> {
  /** Jobs the worker may run now. */
  allowed: T[];
  /** Jobs held back; they stay pending and are reconsidered next poll. */
  deferred: T[];
  /** Platforms that hit their ceiling in this claim — surface, don't swallow. */
  cappedPlatforms: string[];
}

export type PlatformBudgets = Record<string, number>;

/**
 * Trim a claim to what each platform's remaining daily allowance permits.
 * Pure: ordering is preserved, because priority was already decided upstream.
 */
export function applyPlatformBudget<T extends BudgetedJob>(
  jobs: T[],
  usedToday: Record<string, number>,
  budgets: PlatformBudgets,
): BudgetResult<T> {
  const remaining = new Map<string, number>();
  const allowed: T[] = [];
  const deferred: T[] = [];
  const capped = new Set<string>();

  for (const job of jobs) {
    const budget = budgets[job.platform];
    if (budget === undefined) {
      // Unbudgeted means unlimited. Silently blocking a platform nobody
      // configured would be its own silent failure.
      allowed.push(job);
      continue;
    }
    if (!remaining.has(job.platform)) {
      remaining.set(job.platform, Math.max(0, budget - (usedToday[job.platform] ?? 0)));
    }
    const left = remaining.get(job.platform) ?? 0;
    if (left <= 0) {
      deferred.push(job);
      capped.add(job.platform);
      continue;
    }
    remaining.set(job.platform, left - 1);
    allowed.push(job);
  }

  return { allowed, deferred, cappedPlatforms: [...capped] };
}

/**
 * Parse "seek=250,linkedin=0" into budgets. Never throws: a malformed entry is
 * dropped rather than taking the whole queue down, and a negative value is
 * treated as unset rather than as "unlimited" — the dangerous reading.
 */
export function parsePlatformBudgets(spec: string | undefined | null): PlatformBudgets {
  const out: PlatformBudgets = {};
  if (!spec) return out;
  for (const part of spec.split(",")) {
    const [rawKey, rawValue] = part.split("=");
    const key = rawKey?.trim();
    if (!key || rawValue === undefined) continue;
    const value = Number(rawValue.trim());
    if (!Number.isFinite(value) || value < 0) continue;
    out[key] = Math.floor(value);
  }
  return out;
}
