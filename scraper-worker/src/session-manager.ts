import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { BrowserContext, Page } from "patchright";
import { encrypt, decrypt } from "./util/encrypt.js";
import { humanType, randomDelay } from "./humanizer.js";
import { log } from "./util/log.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSIONS_DIR = join(__dirname, "../sessions");

if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });

function sessionPath(platform: string): string {
  return join(SESSIONS_DIR, `${platform}.enc`);
}

export async function saveSession(platform: string, context: BrowserContext): Promise<void> {
  const key = process.env.SESSION_ENCRYPTION_KEY;
  if (!key) return;
  try {
    const cookies = await context.cookies();
    const storage = await context.storageState();
    const data = JSON.stringify({ cookies, storage });
    writeFileSync(sessionPath(platform), encrypt(data, key), "utf8");
    log.debug(`session saved for ${platform}`);
  } catch (err) {
    log.warn(`failed to save session for ${platform}:`, err);
  }
}

export async function loadSession(platform: string, context: BrowserContext): Promise<boolean> {
  const key = process.env.SESSION_ENCRYPTION_KEY;
  const path = sessionPath(platform);
  if (!key || !existsSync(path)) return false;
  try {
    const raw = readFileSync(path, "utf8");
    const { cookies, storage } = JSON.parse(decrypt(raw, key));
    if (cookies?.length) await context.addCookies(cookies);
    if (storage?.origins?.length) {
      for (const origin of storage.origins) {
        for (const item of origin.localStorage ?? []) {
          await context.addInitScript(
            `localStorage.setItem(${JSON.stringify(item.name)}, ${JSON.stringify(item.value)})`,
          );
        }
      }
    }
    return true;
  } catch (err) {
    log.warn(`failed to load session for ${platform}:`, err);
    return false;
  }
}

export async function isSessionValid(platform: string, page: Page): Promise<boolean> {
  try {
    if (platform === "linkedin") {
      await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 15_000 });
      return !page.url().includes("/login") && !page.url().includes("/checkpoint");
    }
    if (platform === "seek") {
      await page.goto("https://talent.seek.com.au/candidates", { waitUntil: "domcontentloaded", timeout: 15_000 });
      return !page.url().includes("/login") && !page.url().includes("/signin");
    }
    return false;
  } catch {
    return false;
  }
}

export async function authenticate(platform: string, page: Page): Promise<void> {
  if (platform === "linkedin") {
    const email = process.env.LINKEDIN_EMAIL;
    const password = process.env.LINKEDIN_PASSWORD;
    if (!email || !password) throw new Error("LINKEDIN_EMAIL/PASSWORD not set");

    await page.goto("https://www.linkedin.com/login", { waitUntil: "domcontentloaded" });
    await randomDelay(800, 1500);
    await humanType(page.locator("#username"), email);
    await randomDelay(400, 900);
    await humanType(page.locator("#password"), password);
    await randomDelay(500, 1000);
    await page.locator('[data-litms-control-urn="login-submit"]').click().catch(() =>
      page.locator('button[type="submit"]').click()
    );
    await page.waitForURL(/linkedin\.com\/(feed|in|jobs)/, { timeout: 20_000 });
    log.info("linkedin: authenticated");
  } else if (platform === "seek") {
    const email = process.env.SEEK_EMAIL;
    const password = process.env.SEEK_PASSWORD;
    if (!email || !password) throw new Error("SEEK_EMAIL/PASSWORD not set");

    await page.goto("https://talent.seek.com.au/login", { waitUntil: "domcontentloaded" });
    await randomDelay(800, 1500);
    const emailInput = page.locator('input[type="email"], input[name="email"]').first();
    await humanType(emailInput, email);
    await randomDelay(400, 900);
    const passwordInput = page.locator('input[type="password"]').first();
    await humanType(passwordInput, password);
    await randomDelay(500, 1000);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(/talent\.seek\.com\.au\/(candidates|dashboard)/, { timeout: 20_000 });
    log.info("seek: authenticated");
  } else {
    throw new Error(`No authentication flow for platform: ${platform}`);
  }
}

export async function ensureSession(
  platform: string,
  context: BrowserContext,
  page: Page,
): Promise<void> {
  const loaded = await loadSession(platform, context);
  if (loaded) {
    const valid = await isSessionValid(platform, page);
    if (valid) {
      log.debug(`${platform}: session valid`);
      return;
    }
    log.info(`${platform}: session expired, re-authenticating`);
  }
  await authenticate(platform, page);
  await saveSession(platform, context);
}
