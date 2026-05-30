import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import process from "node:process";

// Cold-start guard: `prisma db push` drops the Postgres-only generated
// `searchTsv` column on every boot, and step 3 then recomputes it over ~14k
// rows (~50s) — a stall on EVERY restart, not just deploys. Step 1
// (apply-schema) already ensures searchTsv exists via ADD COLUMN IF NOT EXISTS,
// and on an UNCHANGED Prisma schema `db push` has no real work to do (it only
// re-drops searchTsv). So we skip steps 2+3 when prisma/schema.prisma is
// byte-identical to what we last fully applied. Fail-safe: any uncertainty
// (no marker, unreadable, hash mismatch, read error) → run the full sequence,
// i.e. exactly today's behavior. The marker lives OUTSIDE the rsync'd app tree
// so a deploy doesn't reset it; a schema-changing deploy naturally mismatches.
const SCHEMA_HASH_FILE =
  process.env.SCHEMA_HASH_FILE ??
  `${process.env.HOME ?? "/home/baeley"}/.recruitme/schema-state.sha256`;

function currentSchemaHash() {
  try {
    return createHash("sha256").update(readFileSync("prisma/schema.prisma")).digest("hex");
  } catch {
    return null; // can't hash → treat as changed (run full sequence)
  }
}

function schemaUnchanged(hash) {
  if (!hash) return false;
  try {
    return existsSync(SCHEMA_HASH_FILE) && readFileSync(SCHEMA_HASH_FILE, "utf8").trim() === hash;
  } catch {
    return false;
  }
}

function recordSchemaHash(hash) {
  if (!hash) return;
  try {
    mkdirSync(dirname(SCHEMA_HASH_FILE), { recursive: true });
    writeFileSync(SCHEMA_HASH_FILE, hash);
  } catch (err) {
    console.warn(`[startup] could not write schema-hash marker (non-fatal): ${err.message}`);
  }
}

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

// Step 1: Apply schema changes that db push can't do safely on its own
// (candidate dedup, adding lastScoredAt + UsageEvent). Idempotent raw SQL.
await runRequiredWithRetry("apply schema changes", process.execPath, ["scripts/apply-schema-changes.mjs"]);

// Steps 2+3: sync Prisma schema drift, then re-apply our raw-SQL steps to
// recreate the searchTsv column db push drops. SKIPPED on an unchanged schema
// (a plain restart) — see the cold-start guard note above. On a changed schema
// (a deploy) this runs exactly as before.
const schemaHash = currentSchemaHash();
if (schemaUnchanged(schemaHash)) {
  console.log("[startup] prisma schema unchanged since last apply — skipping db push + FTS rebuild (fast restart)");
} else {
  // Step 2: Sync remaining schema drift. `--accept-data-loss` is REQUIRED: the
  // Postgres-only `Candidate.searchTsv` generated tsvector column can't be
  // represented in Prisma's schema, so db push drops it (Postgres recomputes
  // it from name/headline/location/profileText — no real data lost). Step 3
  // recreates it.
  if (existsSync(prismaBin)) {
    const dbPushArgs = ["db", "push", "--skip-generate", "--accept-data-loss"];
    await runRequiredWithRetry("sync database schema", prismaBin, dbPushArgs);
  } else {
    console.error("[startup] Prisma CLI not found; cannot sync database schema");
    process.exit(1);
  }

  // Step 3: Re-apply our raw-SQL schema steps. Most are no-ops (`IF NOT EXISTS`
  // everywhere); the one that matters is step 29, which recreates the searchTsv
  // generated column + GIN index that db push just dropped.
  await runRequiredWithRetry("re-apply post-push schema steps", process.execPath, ["scripts/apply-schema-changes.mjs"]);

  // Mark this schema as fully applied so the next plain restart can fast-path.
  // Written only AFTER both steps succeed (a crash mid-apply leaves it stale →
  // next boot re-runs the full sequence, which is safe).
  recordSchemaHash(schemaHash);
}

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
