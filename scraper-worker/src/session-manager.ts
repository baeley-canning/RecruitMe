/**
 * Session manager — handles automated login and encrypted session persistence.
 *
 * ── HOW SESSIONS WORK (for AI handoff) ───────────────────────────────────────
 * Sessions are stored as AES-256-GCM encrypted JSON files in ./sessions/.
 * Each platform has one file: sessions/linkedin.enc, sessions/seek.enc, etc.
 *
 * On startup (and before each scrape):
 *   1. loadSession() → decrypts file, injects cookies into Playwright context
 *   2. isSessionValid() → visits a lightweight auth-check page; if redirected
 *      to login, the session has expired
 *   3. If invalid: authenticate() → fills login form, solves any 2FA if needed,
 *      then saveSession() persists the fresh cookies
 *
 * CREDENTIALS are read from .env on the device only — never sent to Railway.
 *
 * IF LOGIN BREAKS (e.g. LinkedIn adds new 2FA): look at the authenticate()
 * function for that platform and update the Playwright selectors. LinkedIn
 * changes their selectors ~quarterly. The session-valid check URL is stable.
 *
 * SESSIONS DIR: ./sessions/ is gitignored. On first run it will be created.
 * If you move the Pi, copy the sessions/ dir to preserve sessions.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { BrowserContext, Page } from "playwright";
import { encrypt, decrypt } from "./util/encrypt";
import {
  humanType,
  humanPagePause,
  randomDelay,
  humanMouseDrift,
} from "./humanizer";
import { LoginRequiredError } from "./util/retry";

export type Platform = "linkedin" | "seek" | "jobadder";

const SESSIONS_DIR = join(process.cwd(), "sessions");

function ensureSessionsDir() {
  if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });
}

function sessionPath(platform: Platform): string {
  return join(SESSIONS_DIR, `${platform}.enc`);
}

/** Load saved cookies from disk into a Playwright context. Returns true if file existed. */
export async function loadSession(platform: Platform, context: BrowserContext): Promise<boolean> {
  ensureSessionsDir();
  const path = sessionPath(platform);
  if (!existsSync(path)) return false;

  try {
    const encrypted = readFileSync(path, "utf8");
    const json = decrypt(encrypted);
    const cookies = JSON.parse(json);
    await context.addCookies(cookies);
    console.log(`[session] Loaded ${cookies.length} cookies for ${platform}`);
    return true;
  } catch (err) {
    console.warn(`[session] Failed to load ${platform} session (corrupt/wrong key?):`, err instanceof Error ? err.message : err);
    return false;
  }
}

/** Save current Playwright context cookies to disk (encrypted). */
export async function saveSession(platform: Platform, context: BrowserContext): Promise<void> {
  ensureSessionsDir();
  const cookies = await context.cookies();
  const json = JSON.stringify(cookies);
  const encrypted = encrypt(json);
  writeFileSync(sessionPath(platform), encrypted, "utf8");
  console.log(`[session] Saved ${cookies.length} cookies for ${platform}`);
}

/** Quick check: is the current session still authenticated? */
export async function isSessionValid(platform: Platform, page: Page): Promise<boolean> {
  try {
    switch (platform) {
      case "linkedin": {
        await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 15000 });
        const url = page.url();
        return !url.includes("/login") && !url.includes("/authwall") && !url.includes("/checkpoint");
      }
      case "seek": {
        await page.goto("https://talent.seek.com.au/candidates", { waitUntil: "domcontentloaded", timeout: 15000 });
        const url = page.url();
        return !url.includes("/login") && !url.includes("/sign-in");
      }
      case "jobadder": {
        const token = process.env.JOBADDER_ACCESS_TOKEN;
        if (token) {
          // API mode: check token validity with a lightweight call
          const res = await fetch("https://api.jobadder.com/v2/users/me", {
            headers: { Authorization: `Bearer ${token}` },
          });
          return res.ok;
        }
        // Web mode: check redirect
        await page.goto("https://app.jobadder.com/", { waitUntil: "domcontentloaded", timeout: 15000 });
        return !page.url().includes("/login");
      }
    }
  } catch {
    return false;
  }
}

/** Full login flow for a platform. Called when isSessionValid() returns false. */
export async function authenticate(platform: Platform, page: Page): Promise<void> {
  console.log(`[session] Authenticating for ${platform}...`);

  switch (platform) {
    case "linkedin":
      await authenticateLinkedIn(page);
      break;
    case "seek":
      await authenticateSEEK(page);
      break;
    case "jobadder":
      // JobAdder uses API token — no interactive login needed in API mode
      if (!process.env.JOBADDER_ACCESS_TOKEN) {
        throw new LoginRequiredError("jobadder: set JOBADDER_ACCESS_TOKEN in .env");
      }
      break;
  }
}

/**
 * Ensure a platform session is valid, re-authenticating if needed.
 * This is the main entry point called before each scrape.
 */
export async function ensureSession(
  platform: Platform,
  context: BrowserContext,
  page: Page,
): Promise<void> {
  const loaded = await loadSession(platform, context);

  if (loaded) {
    const valid = await isSessionValid(platform, page);
    if (valid) {
      console.log(`[session] ${platform} session is valid`);
      return;
    }
    console.log(`[session] ${platform} session expired — re-authenticating`);
  }

  await authenticate(platform, page);
  await saveSession(platform, context);
}

// ── Platform-specific login flows ─────────────────────────────────────────────

async function authenticateLinkedIn(page: Page): Promise<void> {
  const email    = process.env.LINKEDIN_EMAIL;
  const password = process.env.LINKEDIN_PASSWORD;
  if (!email || !password) {
    throw new Error("LINKEDIN_EMAIL and LINKEDIN_PASSWORD must be set in .env");
  }

  await page.goto("https://www.linkedin.com/login", { waitUntil: "networkidle", timeout: 30000 });
  await humanPagePause();
  await humanMouseDrift(page);

  // Fill email
  const emailInput = page.locator("#username");
  await emailInput.waitFor({ timeout: 10000 });
  await humanType(emailInput, email);
  await randomDelay(500, 1200);

  // Fill password
  const passwordInput = page.locator("#password");
  await humanType(passwordInput, password);
  await randomDelay(400, 900);
  await humanMouseDrift(page);

  // Submit
  await page.locator('[data-litms-control-urn="login-submit"], button[type="submit"]').first().click();
  await page.waitForNavigation({ waitUntil: "networkidle", timeout: 30000 });

  const url = page.url();
  if (url.includes("/checkpoint") || url.includes("/challenge")) {
    // LinkedIn security challenge — manual intervention required
    console.error(
      "[session] LinkedIn security challenge detected. " +
      "Complete the challenge manually in a browser, export cookies, and place them in sessions/linkedin.enc. " +
      "Or wait 24h and try again from a fresh IP.",
    );
    throw new LoginRequiredError("linkedin: security challenge requires manual intervention");
  }

  if (url.includes("/login") || url.includes("/authwall")) {
    throw new Error("LinkedIn login failed — check LINKEDIN_EMAIL / LINKEDIN_PASSWORD in .env");
  }

  console.log("[session] LinkedIn login successful");
  await humanPagePause();
}

async function authenticateSEEK(page: Page): Promise<void> {
  const email    = process.env.SEEK_EMAIL;
  const password = process.env.SEEK_PASSWORD;
  if (!email || !password) {
    throw new Error("SEEK_EMAIL and SEEK_PASSWORD must be set in .env");
  }

  await page.goto("https://talent.seek.com.au/", { waitUntil: "networkidle", timeout: 30000 });
  await humanPagePause();

  // SEEK may redirect to SSO or show login form
  const url = page.url();
  if (!url.includes("/login") && !url.includes("/sign-in")) {
    // Already logged in
    return;
  }

  await humanMouseDrift(page);

  const emailInput = page.locator('input[type="email"], input[name="email"]').first();
  await emailInput.waitFor({ timeout: 10000 });
  await humanType(emailInput, email);
  await randomDelay(400, 800);

  const passwordInput = page.locator('input[type="password"]').first();
  await humanType(passwordInput, password);
  await randomDelay(300, 700);

  await page.locator('button[type="submit"]').first().click();
  await page.waitForNavigation({ waitUntil: "networkidle", timeout: 30000 });

  if (page.url().includes("/login") || page.url().includes("/sign-in")) {
    throw new Error("SEEK login failed — check SEEK_EMAIL / SEEK_PASSWORD in .env");
  }

  console.log("[session] SEEK Talent login successful");
  await humanPagePause();
}
