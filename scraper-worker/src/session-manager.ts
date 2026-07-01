import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { Browser, BrowserContext, Page } from "patchright";
import { randomViewport, DESKTOP_USER_AGENT } from "./humanizer.js";
import { encrypt, decrypt } from "./util/encrypt.js";
import { humanType, randomDelay } from "./humanizer.js";
import { log } from "./util/log.js";
import {
  createBreakerState,
  isCircuitOpen,
  recordAuthFailure,
  recordAuthSuccess,
  classifyAuthFailure,
} from "./auth-failure.js";

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
    const bytes = statSync(sessionPath(platform)).size;
    log.info(`session saved for ${platform} (${bytes} bytes) -> ${sessionPath(platform)}`);
  } catch (err) {
    log.warn(`failed to save session for ${platform}:`, err);
  }
}

/**
 * Read the saved storageState for a platform (cookies + per-origin
 * localStorage). Returns null if no session saved. The caller uses this with
 * `browser.newContext({ storageState })`, which is Playwright's canonical way
 * to restore a session — correctly applies localStorage to each origin (which
 * `addInitScript` cannot do). Required for any auth flow that uses a separate
 * SSO origin (Auth0, Okta, etc.) — e.g. JobAdder, which logs in via
 * `login.jobadder.com` and stores Auth0 tokens there.
 */
/**
 * Open a FRESH browser context populated with the saved storageState for a
 * platform — the canonical Playwright pattern. Required for JobAdder because
 * Auth0 stores tokens in localStorage on a different origin (login.jobadder.com)
 * than the app (au6.jobadder.com), which `addInitScript` cannot restore
 * correctly. Returns { context, page } the caller must close when done.
 */
export async function openContextWithSavedSession(
  browser: Browser,
  platform: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const state = loadStorageStateFromDisk(platform);
  if (!state) {
    throw new Error(`No saved session for ${platform} — run login.ts ${platform}`);
  }
  // Cast to Playwright's StorageState shape — the on-disk JSON matches.
  // The on-disk storage state JSON matches Playwright's expected shape exactly
  // (cookies + origins[].localStorage). Pass through with a structural cast.
  const context = await browser.newContext({
    viewport: randomViewport(),
    userAgent: DESKTOP_USER_AGENT,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    storageState: state as any,
  });
  const page = await context.newPage();
  return { context, page };
}

export function loadStorageStateFromDisk(
  platform: string,
): { cookies: unknown[]; origins: unknown[] } | null {
  const key = process.env.SESSION_ENCRYPTION_KEY;
  const path = sessionPath(platform);
  if (!key || !existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(decrypt(raw, key));
    // We persist `storage` in saveSession (the result of context.storageState()).
    // Older sessions might only have `cookies` — fall back gracefully.
    if (parsed.storage) return parsed.storage;
    if (parsed.cookies) return { cookies: parsed.cookies, origins: [] };
    return null;
  } catch (err) {
    log.warn(`failed to load storage state for ${platform}:`, err);
    return null;
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

// SEEK multi-advertiser accounts (placeMe has more than one) need the
// account/advertiser scope established BEFORE /talentsearch/search will load.
// Going straight to talent search "cold" spins forever in a
// /account/select → /oauth/integration(loginWithScope) → /oauth/callback →
// /talentsearch/search → /account/select loop. THIS — not auth — is the real
// cause of the recurring "SEEK session expired / Pulse down": the patchright
// login itself always succeeds, but the cold scope acquisition never settles.
// Hitting /account/select WITHOUT a returnUrl lets SEEK resolve the single
// effective account and land on /dashboard, warming the advertiser scope into
// this browser context; the very next /talentsearch/search nav (scrapeSeekSearch,
// same page) then loads instantly. Returns false (leaving the page wherever it
// bounced) when the session is genuinely expired, so the caller re-authenticates.
// Live-verified on the box 2026-06-22.
export async function warmSeekAccount(page: Page): Promise<boolean> {
  const host = process.env.SEEK_EMPLOYER_HOST ?? "https://nz.employer.seek.com";
  await page.goto(`${host}/account/select`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  // Resolves through /oauth/callback to /dashboard once the account is set; a
  // genuinely expired session instead bounces to authenticate.seek.com/login.
  // Generous timeout: the /account/select → /oauth/callback → /dashboard chain
  // can be slow on a cold session load, and a premature false-negative here
  // cascades into a doomed re-auth (see authenticate()), so wait it out.
  const settled = /employer\.seek\.com\/(dashboard|talentsearch)/;
  await page.waitForURL(settled, { timeout: 30_000 }).catch(() => {});
  if (settled.test(page.url())) return true;
  // One retry — a single cold redirect chain occasionally stalls; re-kick it.
  if (!/authenticate\.seek\.com/i.test(page.url())) {
    await page.goto(`${host}/account/select`, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
    await page.waitForURL(settled, { timeout: 30_000 }).catch(() => {});
  }
  // Success = settled on an authed app page (dashboard/talentsearch), not still
  // stuck in the account-select/oauth shuffle and not bounced to login.
  return settled.test(page.url());
}

export async function isSessionValid(platform: string, page: Page): Promise<boolean> {
  // A single probe: navigate to an authed page and check we weren't bounced to a
  // login URL. Throws only on a navigation error (timeout / network).
  const probe = async (): Promise<boolean> => {
    if (platform === "linkedin") {
      await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 15_000 });
      return !page.url().includes("/login") && !page.url().includes("/checkpoint");
    }
    if (platform === "seek") {
      // Validate AND warm the advertiser scope in one step (placeMe is an NZ
      // account on nz.employer.seek.com; override via SEEK_EMPLOYER_HOST). We
      // deliberately do NOT probe /talentsearch/search directly: that loops on
      // cold advertiser-scope acquisition (see warmSeekAccount). Warming via
      // /account/select both checks the session IS authed (lands on /dashboard)
      // and primes this context so the following scrapeSeekSearch nav loads.
      return await warmSeekAccount(page);
    }
    if (platform === "jobadder") {
      // JobAdder uses regional subdomains (au6, us1, etc.) — match any
      // *.jobadder.com host. Override via JOBADDER_BASE_URL if needed.
      const base = process.env.JOBADDER_BASE_URL ?? "https://au6.jobadder.com";
      await page.goto(`${base}/dashboards/jobs`, { waitUntil: "domcontentloaded", timeout: 15_000 });
      const u = page.url();
      // Note: do NOT include "account" in the exclusion regex — JobAdder uses
      // /Account/SignIn for the auth flow but ALSO has /account/... paths for
      // authenticated UI screens. Match only paths that are unambiguously sign-in.
      const onAuthPath = /\/(SignIn|sign-in|signin|login|sso)/i.test(u);
      log.info(`jobadder: isSessionValid landed at ${u} (onAuth=${onAuthPath})`);
      return /\.jobadder\.com/.test(u) && !onAuthPath;
    }
    return false;
  };

  // Retry ONCE on a thrown error (a transient nav timeout / network blip). A
  // single slow navigation must not be misread as "session expired" — that
  // misread is what triggered a doomed SEEK auto-re-auth (Turnstile-gated) and
  // tripped the 2h circuit on a still-valid session. A clean landing on a login
  // URL still returns false immediately (genuine expiry — no retry needed).
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await probe();
    } catch (err) {
      if (attempt === 2) {
        log.warn(`${platform}: isSessionValid probe errored twice (${err instanceof Error ? err.message : String(err)}) — treating as invalid`);
        return false;
      }
      await randomDelay(1500, 3000);
    }
  }
  return false;
}

export async function authenticate(platform: string, page: Page): Promise<void> {
  if (platform === "linkedin") {
    const email = process.env.LINKEDIN_EMAIL;
    const password = process.env.LINKEDIN_PASSWORD;
    if (!email || !password) throw new Error("LINKEDIN_EMAIL/PASSWORD not set");

    await page.goto("https://www.linkedin.com/login", { waitUntil: "domcontentloaded" });
    await randomDelay(800, 1500);
    // LinkedIn's React login uses auto-generated ids (e.g. ":r3:"), so target
    // by input type + visibility rather than the old #username/#password ids.
    const emailInput = page.locator('input[type="email"]:visible').first();
    await emailInput.waitFor({ state: "visible", timeout: 30_000 });
    await humanType(emailInput, email);
    await randomDelay(400, 900);
    const pwInput = page.locator('input[type="password"]:visible').first();
    await humanType(pwInput, password);
    await randomDelay(500, 1000);
    // Submit: Enter in the password field is the most robust (avoids the
    // React button's whitespace/duplicate-form selector pitfalls); fall back
    // to clicking the primary "Sign in" button if Enter didn't navigate.
    await pwInput.press("Enter").catch(() => {});
    await page.getByRole("button", { name: "Sign in", exact: true })
      .first().click({ timeout: 5_000 }).catch(() => {});
    // feed/in/jobs = success. /checkpoint = a human verification challenge —
    // NOT matched here, so this times out and the caller fails the job, which
    // is the signal that a manual login (login.ts) is needed.
    await page.waitForURL(/linkedin\.com\/(feed|in|jobs)/, { timeout: 30_000 });
    log.info("linkedin: authenticated");
  } else if (platform === "seek") {
    const email = process.env.SEEK_EMAIL;
    const password = process.env.SEEK_PASSWORD;
    if (!email || !password) throw new Error("SEEK_EMAIL/PASSWORD not set");

    // SEEK migrated hirer login to an Auth0 Universal Login behind
    // /oauth/login/. The old talent.seek.com.au/login now 302s to a 404
    // marketing page (no email field) — which is why auto-reauth was timing
    // out on input[type="email"]. The /oauth/login/ entry redirects to
    // authenticate.seek.com with the real single-page email+password form:
    //   email    → #emailAddress (name="emailAddress_hirer")
    //   password → #password     (name="password_hirer")
    //   submit   → button[type="submit"] ("Sign in")
    // A Cloudflare Turnstile widget guards the form; under patchright it
    // usually solves invisibly. If it blocks (interactive challenge), the
    // waitForURL below times out and the caller fails the job — the signal
    // that a manual `npx tsx login.ts seek` is needed.
    // Region-specific: log in through the NZ employer portal so the session is
    // valid for nz.employer.seek.com/talentsearch (placeMe is an NZ account).
    // Navigating there unauthenticated 302s to authenticate.seek.com (Auth0)
    // with the NZ redirect_uri. Override host via SEEK_EMPLOYER_HOST.
    const host = process.env.SEEK_EMPLOYER_HOST ?? "https://nz.employer.seek.com";
    await page.goto(`${host}/talentsearch/search`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await randomDelay(1500, 2500); // let the Auth0 redirect settle before deciding
    // RESILIENCE: decide "logged in?" by the URL, NOT by racing the form render.
    // A still-valid session stays on the employer portal (redirects among
    // /account/select, /dashboard, /oauth/*). An EXPIRED session bounces to
    // authenticate.seek.com — where the Turnstile-guarded Auth0 form takes 15-25s
    // to appear. The old code probed the email field with a 12s timeout and read
    // "no form yet" as "session valid", so on a genuinely-expired session (slow
    // Turnstile form) it SKIPPED the re-login and every SEEK search then died on
    // the login page ("keyword box not found on authenticate.seek.com"). URL-based
    // avoids BOTH that false-positive and the earlier false-negative (a valid
    // session never renders this form, so waiting 30s for it used to throw → 2h
    // circuit trip). Live-verified 2026-07-02: form visible by ~25s, login OK.
    if (!/authenticate\.seek\.com/i.test(page.url())) {
      log.info(`seek: session still valid (${page.url()}) — warming scope, skipping credential login`);
      await warmSeekAccount(page).catch(() => {});
      return;
    }
    // Expired → drive the Auth0 credential login. Wait generously for the form
    // (Turnstile delays its render); if it never appears the login is genuinely
    // blocked (interactive challenge) → the waitFor throws → the caller fails.
    const emailInput = page.locator('#emailAddress, input[name="emailAddress_hirer"], input[type="email"]').first();
    await emailInput.waitFor({ state: "visible", timeout: 30_000 });
    await randomDelay(800, 1500);
    await humanType(emailInput, email);
    await randomDelay(400, 900);
    const passwordInput = page.locator('#password, input[name="password_hirer"], input[type="password"]').first();
    await humanType(passwordInput, password);
    await randomDelay(500, 1000);
    await page.locator('button[type="submit"]').first().click();
    // Success = bounced back off the Auth0 host onto an authenticated SEEK
    // host (the OAuth callback lands on au.employer.seek.com, then the talent
    // app). Accept either employer or talent host as the logged-in signal.
    await page.waitForURL(/(talent\.seek\.com\.au|employer\.seek\.com)(?!.*\/(login|oauth|sign-in))/, { timeout: 30_000 });
    log.info("seek: authenticated");
    // Establish the advertiser scope so the session we save next can hit talent
    // search directly — a fresh login lands on /account/select, which loops if
    // not resolved first (multi-account portal; see warmSeekAccount). Best-effort:
    // the per-job isSessionValid re-warms anyway.
    await warmSeekAccount(page).catch(() => {});
  } else if (platform === "jobadder") {
    // No automated re-auth for JobAdder — credentials aren't in env and the
    // login flow has multi-step / 2FA dependent on the agency's setup. If the
    // session is invalid, the operator must run `npx tsx login.ts jobadder`
    // by hand.
    throw new Error(
      "JobAdder session invalid or missing — re-run `npx tsx login.ts jobadder` on the desktop.",
    );
  } else {
    throw new Error(`No authentication flow for platform: ${platform}`);
  }
}

// Per-platform re-auth circuit breaker state, held for the worker's lifetime.
// Pure breaker logic lives in ./auth-failure (unit-tested); this just holds the
// state and injects the clock so a broken login can't spin authenticate()
// forever (see auth-failure.ts header).
let authBreaker = createBreakerState();

// Roll the saved session forward. SEEK (and others) rotate their session cookies
// over time, but the worker only ever LOADED the saved file and never re-saved
// it — so the stored session aged out to the ORIGINAL capture's cookie expiry
// and eventually died, forcing a manual re-login (the saved seek.enc was weeks
// old). Re-persisting the now-server-refreshed cookies whenever the session is
// confirmed valid keeps a regularly-used session alive on its own. Throttled by
// the file's age so we don't churn the encrypted file every job.
const SESSION_REFRESH_MS = 3 * 60 * 60 * 1000; // re-save at most every 3h
async function rollSessionForward(platform: string, context: BrowserContext): Promise<void> {
  try {
    const p = sessionPath(platform);
    const ageMs = existsSync(p) ? Date.now() - statSync(p).mtimeMs : Infinity;
    if (ageMs > SESSION_REFRESH_MS) {
      await saveSession(platform, context);
      log.info(`${platform}: session re-saved (rolling refresh; was ~${Math.round(ageMs / 3.6e6)}h old)`);
    }
  } catch (err) {
    // Non-fatal — a failed refresh just means the session ages as before.
    log.warn(`${platform}: rolling session re-save failed (${err instanceof Error ? err.message : String(err)})`);
  }
}

export async function ensureSession(
  platform: string,
  context: BrowserContext,
  page: Page,
): Promise<void> {
  if (isCircuitOpen(authBreaker, platform, Date.now())) {
    // SELF-HEAL: a transient blip can trip the breaker while the session is
    // still VALID — without this, the 2h cooldown needlessly locks out a working
    // session (observed: a misread "session expired" → doomed Turnstile re-auth
    // → circuit OPEN → every SEEK job blocked for 2h on a perfectly valid
    // session, only cleared by a manual restart). Cheaply re-probe BEFORE
    // blocking: isSessionValid only navigates — it does NOT call authenticate() —
    // so it can't re-spam the login that opened the circuit. If the session is
    // actually fine, close the circuit and resume.
    if ((await loadSession(platform, context)) && (await isSessionValid(platform, page))) {
      authBreaker = recordAuthSuccess(authBreaker, platform);
      await rollSessionForward(platform, context);
      log.info(`${platform}: circuit was open but the session is valid — closing circuit, resuming`);
      return;
    }
    // Genuinely still invalid → needs a manual re-login. Prefix with
    // "<platform>_challenge:" so this is classified as an AUTH failure, not a
    // transient one: the worker (isAuthChallengeMessage) skips the rate-limit
    // backoff, and the API PATCH route treats it as a final no-retry failure
    // instead of requeuing until the retry budget is spent.
    throw new Error(
      `${platform}_challenge: auth circuit open after repeated re-auth failures — run \`npx tsx login.ts ${platform}\` on the box; it clears automatically on the next success or after the cooldown.`,
    );
  }

  const loaded = await loadSession(platform, context);
  if (loaded) {
    const valid = await isSessionValid(platform, page);
    if (valid) {
      authBreaker = recordAuthSuccess(authBreaker, platform);
      await rollSessionForward(platform, context);
      log.debug(`${platform}: session valid`);
      return;
    }
    log.info(`${platform}: session expired, re-authenticating`);
  }

  try {
    await authenticate(platform, page);
    await saveSession(platform, context);
    authBreaker = recordAuthSuccess(authBreaker, platform);
  } catch (err) {
    const kind = classifyAuthFailure(err);
    authBreaker = recordAuthFailure(authBreaker, platform, kind, Date.now());
    const opened = isCircuitOpen(authBreaker, platform, Date.now());
    log.warn(
      `${platform}: re-auth ${kind} failure (${err instanceof Error ? err.message : String(err)})` +
        (opened ? " — circuit OPEN, pausing re-auth attempts for this platform" : " — will retry on next job"),
    );
    throw err;
  }
}
