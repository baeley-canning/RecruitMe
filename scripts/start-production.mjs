import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

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

// Step 2: Sync any remaining schema drift (safe now that unique constraints are clean)
if (existsSync(prismaBin)) {
  await runRequiredWithRetry("sync database schema", prismaBin, ["db", "push", "--skip-generate", "--accept-data-loss"]);
} else {
  console.error("[startup] Prisma CLI not found; cannot sync database schema");
  process.exit(1);
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
