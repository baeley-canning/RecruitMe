import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createPrisma() {
  const client = new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
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
