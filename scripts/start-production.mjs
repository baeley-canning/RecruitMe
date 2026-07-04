import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

// NOTE: the schema-hash "skip db push on unchanged schema" guard was removed
// 2026-07-05 when the boot moved off destructive `db push --accept-data-loss`
// to `prisma migrate deploy`. Its whole purpose was to avoid the ~50s
// searchTsv rebuild that db push forced on every boot; migrate deploy never
// drops searchTsv, so there's nothing to guard against — every boot runs
// migrate deploy (no-op when nothing's pending) + the idempotent raw-SQL step.

function run(label, command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
    shell: false,
  });

  if (result.error) return { ok: false, reason: result.error.message };
  if (result.status && result.status !== 0) return { ok: false, reason: `exit ${result.status}` };

  return { ok: true, reason: null };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runRequiredWithRetry(label, command, args) {
  const attempts = Number.parseInt(process.env.STARTUP_DB_RETRIES ?? "12", 10);
  const delayMs = Number.parseInt(process.env.STARTUP_DB_RETRY_DELAY_MS ?? "5000", 10);
  const maxAttempts = Number.isFinite(attempts) && attempts > 0 ? attempts : 12;
  const waitMs = Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : 5000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    console.log(`[startup] ${label} (${attempt}/${maxAttempts})`);
    const result = run(label, command, args);
    if (result.ok) return;

    if (attempt === maxAttempts) {
      console.error(`[startup] ${label} failed: ${result.reason}`);
      process.exit(1);
    }

    console.warn(`[startup] ${label} failed: ${result.reason}; retrying in ${waitMs}ms`);
    await delay(waitMs);
  }
}

const prismaBin = process.platform === "win32"
  ? "node_modules/.bin/prisma.cmd"
  : "node_modules/.bin/prisma";

// Schema management (cut over 2026-07-05 from destructive `db push
// --accept-data-loss` to real migrations):
//
// Step 1 — `prisma migrate deploy`: applies any PENDING migrations in
// prisma/migrations. On the existing prod DB (baselined so `0_init` is already
// marked applied) this is a clean NO-OP; on a FRESH database it builds the
// whole schema from `0_init`. Crucially it NEVER drops the Postgres-only
// `Candidate.searchTsv` generated column — the old db-push path dropped +
// recomputed it (~50s FTS rebuild) on every schema-changing deploy. Verified
// on a shadow DB both ways (baseline-existing no-op AND fresh-from-empty)
// before this cutover shipped.
if (existsSync(prismaBin)) {
  await runRequiredWithRetry("migrate deploy", prismaBin, ["migrate", "deploy"]);
} else {
  console.error("[startup] Prisma CLI not found; cannot run migrate deploy");
  process.exit(1);
}

// Step 2 — idempotent raw-SQL that Prisma migrations can't own: the
// `searchTsv` generated tsvector column + its GIN index + the trigram indexes
// (Prisma 5 has no first-class tsvector mapping). Every step is
// `... IF NOT EXISTS`, so on an already-provisioned DB it's a fast no-op; on a
// fresh DB it adds the search machinery on top of the migrated schema. This is
// the SAME apply-schema-changes.mjs that ran before — it just no longer has to
// undo a db-push drop.
await runRequiredWithRetry("apply post-migrate raw SQL (searchTsv + indexes)", process.execPath, ["scripts/apply-schema-changes.mjs"]);

await runRequiredWithRetry("seed owner account", process.execPath, ["prisma/seed.js"]);

const nextBin = "node_modules/next/dist/bin/next";
const port = process.env.PORT || "3000";

console.log(`[startup] starting Next on 0.0.0.0:${port}`);
const next = spawn(process.execPath, [nextBin, "start", "-H", "0.0.0.0", "-p", port], {
  stdio: "inherit",
  env: process.env,
  shell: false,
});

next.on("exit", (code, signal) => {
  if (signal) {
    console.error(`[startup] Next exited from signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});

next.on("error", (error) => {
  console.error(`[startup] Failed to start Next: ${error.message}`);
  process.exit(1);
});
