// One-time interactive login helper (matches the .enc session design in
// HANDOFF.md). Opens a VISIBLE browser; you log in by hand (solve any
// challenge); it saves the encrypted session to sessions/{platform}.enc,
// which the worker reuses.
// Run on the desktop:  cd ~/scraper-worker && npx tsx login.ts linkedin
//                      cd ~/scraper-worker && npx tsx login.ts seek
//                      cd ~/scraper-worker && npx tsx login.ts jobadder
import { chromium } from "patchright";
import { saveSession } from "./src/session-manager.js";
import { randomViewport, DESKTOP_USER_AGENT } from "./src/humanizer.js";
import { existsSync, statSync } from "fs";
import { createInterface } from "readline";

// Load .env so SESSION_ENCRYPTION_KEY is set for saveSession() — run directly,
// this script doesn't get the worker's --env-file. Without it the save no-ops.
try { process.loadEnvFile(); } catch { /* rely on ambient env */ }
if (!process.env.SESSION_ENCRYPTION_KEY) {
  console.error("ERROR: SESSION_ENCRYPTION_KEY not set (run from ~/scraper-worker so .env loads). Aborting so we don't fake a save.");
  process.exit(1);
}

const arg = process.argv[2];
const platform: "linkedin" | "seek" | "jobadder" =
  arg === "seek" ? "seek" : arg === "jobadder" ? "jobadder" : "linkedin";
// JobAdder uses regional subdomains (au6, us1, etc.). Override with
// JOBADDER_BASE_URL in .env if your account is not on au6.jobadder.com.
const JOBADDER_BASE_URL = process.env.JOBADDER_BASE_URL ?? "https://au6.jobadder.com";
const SEEK_EMPLOYER_HOST = process.env.SEEK_EMPLOYER_HOST ?? "https://nz.employer.seek.com";
const loginUrl =
  platform === "seek"     ? `${SEEK_EMPLOYER_HOST}/talentsearch/search` :
  platform === "jobadder" ? `${JOBADDER_BASE_URL}/dashboards/jobs` :
                            "https://www.linkedin.com/login";

const ozoneArgs = process.env.OZONE === "wayland" ? ["--ozone-platform=wayland"]
  : process.env.OZONE === "x11" ? ["--ozone-platform=x11"]
  : ["--ozone-platform-hint=auto"];

const browser = await chromium.launch({ headless: false, args: ozoneArgs });
const context = await browser.newContext({ viewport: randomViewport(), userAgent: DESKTOP_USER_AGENT });
const page = await context.newPage();
await page.goto(loginUrl, { waitUntil: "domcontentloaded" });

console.log("\n========================================================");
console.log("Log into " + platform.toUpperCase() + " by hand in the browser window.");
console.log("Solve any verification code / challenge if it appears.");
console.log("");
console.log(">>> Once you can see your logged-in " + platform.toUpperCase() + " home/dashboard,");
console.log(">>> come back HERE and press ENTER to save the session.");
console.log("(It also auto-saves if it detects the login cookie. Waits up to 8 min.)");
console.log("========================================================\n");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Trigger A: auto-detect the platform's auth cookie / authed URL.
const autoDetect = (async () => {
  const deadline = Date.now() + 8 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(2000);
    const cookies = await context.cookies().catch(() => []);
    const url = page.url();
    if (platform === "linkedin" && cookies.some((c) => c.name === "li_at" && c.value)) return "auto";
    if (
      platform === "seek" &&
      /employer\.seek\.com/.test(url) &&
      !/authenticate\.seek\.com|\/(login|signin|sign-in|oauth)/i.test(url) &&
      cookies.length > 3
    ) return "auto";
    if (
      platform === "jobadder" &&
      /\.jobadder\.com/.test(url) &&
      !/\/(login|signin|sign-in|account|sso)/i.test(url) &&
      cookies.length > 3
    ) return "auto";
  }
  return null as string | null;
})();

// Trigger B: you press ENTER in the terminal once you're logged in. This is the
// reliable path — auto-detect can miss SEEK's cookie names, so manual always works.
const rl = createInterface({ input: process.stdin, output: process.stdout });
const manual = new Promise<string>((resolve) => rl.once("line", () => resolve("manual")));

const trigger = await Promise.race([autoDetect, manual]);
rl.close();

if (trigger) {
  await saveSession(platform, context);
  const path = "sessions/" + platform + ".enc";
  if (existsSync(path) && statSync(path).size > 0) {
    console.log("\n[OK] " + platform + " session saved (" + statSync(path).size + " bytes) -> " + path);
    console.log("The worker will reuse this — you should NOT need to log in again unless cookies expire.");
  } else {
    console.log("\n[WARN] saveSession ran but " + path + " is missing/empty. Check SESSION_ENCRYPTION_KEY.");
  }
} else {
  console.log("\n[TIMEOUT] Not detected within 8 min and ENTER not pressed — nothing saved. Re-run to try again.");
}
await browser.close();
process.exit(trigger ? 0 : 1);
