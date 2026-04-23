import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

function runOptional(label, command, args) {
  console.log(`[startup] ${label}`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
    shell: false,
  });

  if (result.error) {
    console.warn(`[startup] ${label} skipped: ${result.error.message}`);
    return;
  }

  if (result.status && result.status !== 0) {
    console.warn(`[startup] ${label} exited with ${result.status}; continuing`);
  }
}

const prismaBin = process.platform === "win32"
  ? "node_modules/.bin/prisma.cmd"
  : "node_modules/.bin/prisma";

if (existsSync(prismaBin)) {
  runOptional("sync database schema", prismaBin, ["db", "push"]);
} else {
  console.warn("[startup] Prisma CLI not found; skipping database schema sync");
}

runOptional("seed owner account", process.execPath, ["prisma/seed.js"]);

const nextBin = "node_modules/next/dist/bin/next";
const port = process.env.PORT || "3000";

console.log(`[startup] starting Next on 0.0.0.0:${port}`);
const next = spawn(process.execPath, [nextBin, "start", "-p", port], {
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
