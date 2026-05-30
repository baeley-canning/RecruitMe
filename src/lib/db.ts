import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * Append Prisma pool tuning to a Postgres DATABASE_URL if not already set.
 *
 * Why this lives in code: Railway env vars are not editable from here, so we
 * can't shape DATABASE_URL at deploy time. Prisma supports `connection_limit`
 * and `pool_timeout` as connection-string query params, so we patch the URL
 * before constructing the client.
 *
 * On a Railway 2-vCPU dyno Prisma defaults to ~5 connections, which the
 * score-all path (CONCURRENCY=3) + poll traffic + sibling routes will starve.
 * Bumping to 10 with a 20s pool_timeout gives headroom without exceeding the
 * Postgres connection ceiling on small plans.
 *
 * Idempotent: only appends when the param isn't already present, so a manual
 * `?connection_limit=N` in DATABASE_URL still wins.
 */
function tunePoolUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  if (url.startsWith("file:")) return url; // SQLite has no pool params
  if (url.includes("connection_limit=")) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}connection_limit=10&pool_timeout=20`;
}

function createPrisma() {
  const datasourceUrl = tunePoolUrl(process.env.DATABASE_URL);
  // Annotate the type explicitly: hoisting this out of the inline spread makes
  // TS infer a `{ datasourceUrl: string } | {}` union whose empty member carries
  // an implicit `datasourceUrl?: undefined`, which isn't assignable to
  // PrismaClientOptions. `{ datasourceUrl?: string }` keeps the spread valid.
  const dsOpt: { datasourceUrl?: string } = datasourceUrl ? { datasourceUrl } : {};
  // Branch construction (rather than a ternary on `log`) so the prod client keeps
  // the literal `emit:"event"` type — that's what makes `$on("query")` below
  // type-check. dev/SQLite keeps the quiet error/warn stdout logging.
  if (process.env.NODE_ENV === "production") {
    const client = new PrismaClient({
      log: [{ emit: "event", level: "query" }, "error", "warn"],
      ...dsOpt,
    });
    // Lightweight slow-query log: surfaces queries >200ms in prod logs without
    // the firehose of logging every statement. Truncated to keep lines readable.
    client.$on("query", (e) => {
      if (e.duration > 200) {
        console.warn("[slow-query] " + e.duration + "ms " + e.query.slice(0, 120));
      }
    });
    return client;
  }

  const client = new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    ...dsOpt,
  });
  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (databaseUrl.startsWith("file:")) {
    // WAL mode allows concurrent reads during writes in SQLite — prevents
    // SQLITE_BUSY under parallel AI scoring / search operations.
    // $queryRawUnsafe is used because PRAGMA journal_mode returns a result set,
    // which $executeRawUnsafe rejects in SQLite.
    client.$queryRawUnsafe("PRAGMA journal_mode=WAL;").catch(() => {});
  }
  return client;
}

export const prisma = globalForPrisma.prisma ?? createPrisma();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
