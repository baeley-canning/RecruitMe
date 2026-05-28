const level = (process.env.LOG_LEVEL ?? "info").toLowerCase();
const LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const current = LEVELS[level] ?? 1;

function ts() {
  return new Date().toISOString();
}

export const log = {
  debug: (...args: unknown[]) => current <= 0 && console.debug(`[${ts()}] DEBUG`, ...args),
  info:  (...args: unknown[]) => current <= 1 && console.log(`[${ts()}] INFO `, ...args),
  warn:  (...args: unknown[]) => current <= 2 && console.warn(`[${ts()}] WARN `, ...args),
  error: (...args: unknown[]) => current <= 3 && console.error(`[${ts()}] ERROR`, ...args),
};
