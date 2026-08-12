import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, statSync } from "fs";
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

/**
 * Does this context still hold a usable login for the platform?
 *
 * The ONLY thing we must never do is write an empty/logged-out context over a
 * good session on disk. Checking for the platform's auth cookies answers that
 * directly and cheaply — far better than inferring it from whether some
 * navigation settled, which is flaky and, when it misfires, throws away the
 * rotated tokens we are supposed to be persisting.
 */
async function contextHasAuthCookies(platform: string, context: BrowserContext): Promise<boolean> {
  try {
    const cookies = await context.cookies();
    if (cookies.length === 0) return false;
    const domainFor: Record<string, RegExp> = {
      seek: /seek\.(com|co\.nz|com\.au)$/i,
      linkedin: /linkedin\.com$/i,
      jobadder: /jobadder\.com$/i,
    };
    const domain = domainFor[platform];
    const relevant = domain ? cookies.filter((c) => domain.test((c.domain ?? "").replace(/^\./, ""))) : cookies;
    // An authenticated context carries session/identity cookies, not just the
    // consent + analytics set a logged-out visitor picks up.
    return relevant.some((c) => /auth|session|token|sid|li_at|jsessionid/i.test(c.name));
  } catch {
    return false;
  }
}

export async function saveSession(platform: string, context: BrowserContext): Promise<void> {
  const key = process.env.SESSION_ENCRYPTION_KEY;
  if (!key) return;
  try {
    // Refuse to clobber a good session with a logged-out context. This is the
    // guard that actually matters; everything else about saving should be
    // eager, because SEEK runs on Auth0 and Auth0 ROTATES refresh tokens —
    // every use mints a new token and invalidates the previous one. A rotation
    // we fail to persist leaves a stored token that is already dead server
    // side, and the next run demands an OTP.
    if (!(await contextHasAuthCookies(platform, context))) {
      log.warn(`${platform}: refusing to save a context with no auth cookies — keeping the stored session`);
      return;
    }
    const cookies = await context.cookies();
    const storage = await context.storageState();
    const data = JSON.stringify({ cookies, storage });
    // Atomic: write a temp file then rename over the target. A direct write that
    // is interrupted (power cut, systemctl restart mid-write) leaves a truncated
    // file; loadStorageStateFromDisk swallows the decrypt error and returns null,
    // so the session silently vanishes and a human has to log in again. rename()
    // is atomic on POSIX, so the file is either the old session or the new one.
    const target = sessionPath(platform);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, encrypt(data, key), "utf8");
    renameSync(tmp, target);
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

/** True when a saved session file exists for the platform (says nothing about
 *  whether it's still valid — isSessionValid decides that). */
export function hasSavedSession(platform: string): boolean {
  return !!process.env.SESSION_ENCRYPTION_KEY && existsSync(sessionPath(platform));
}

// ── per-platform browser contexts ────────────────────────────────────────────
//
// The old design shared ONE context across LinkedIn + SEEK and re-applied the
// saved session on EVERY job via addCookies + addInitScript. Init scripts can
// never be removed from a context, so each ensureSession stacked another layer
// of localStorage-setters that re-forced STALE tokens onto every subsequent
// page load — and saveSession then persisted BOTH platforms' accumulated state
// (observed: a 295KB seek.enc vs ~46KB healthy). That compounding staleness is
// what rotted the SEEK login ~20 minutes after every clean re-auth. A fresh
// context per platform built from the saved storageState (the canonical
// Playwright pattern, already proven by the JobAdder path) keeps platforms
// isolated, never stacks init scripts, and keeps the saved session small.

interface PlatformSession {
  context: BrowserContext;
  page: Page;
}

const platformSessions = new Map<string, PlatformSession>();

function contextOptions(): Record<string, unknown> {
  return {
    viewport: randomViewport(),
    userAgent: DESKTOP_USER_AGENT,
    ...(process.env.HTTP_PROXY ? { proxy: { server: process.env.HTTP_PROXY } } : {}),
  };
}

/**
 * The long-lived context+page for a platform, created on first use from the
 * saved storageState. `fresh: true` builds a VIRGIN context (no saved state) —
 * used for credential re-login so the session we then save contains only the
 * clean post-login state, never inherited rot.
 */
export async function getPlatformPage(
  browser: Browser,
  platform: string,
  opts?: { fresh?: boolean },
): Promise<PlatformSession> {
  const existing = platformSessions.get(platform);
  if (existing && !opts?.fresh && !existing.page.isClosed()) return existing;
  if (existing) {
    platformSessions.delete(platform);
    await existing.context.close().catch(() => {});
  }
  const state = opts?.fresh ? null : loadStorageStateFromDisk(platform);
  const context = await browser.newContext({
    ...contextOptions(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(state ? { storageState: state as any } : {}),
  });
  const page = await context.newPage();
  const session = { context, page };
  platformSessions.set(platform, session);
  return session;
}

/** Close and forget a platform's context (wedged page, poisoned state). The
 *  next getPlatformPage rebuilds it from the saved session file. */
export async function discardPlatformSession(platform: string): Promise<void> {
  const s = platformSessions.get(platform);
  platformSessions.delete(platform);
  if (s) await s.context.close().catch(() => {});
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
  const finalUrl = page.url();
  const ok = settled.test(finalUrl);
  // Log the FINAL url on failure. A false negative here is expensive: it is read
  // as "session expired" and triggers a doomed re-auth, so when the owner says
  // the box is plainly logged in and this still fails, the landing URL is the
  // only thing that settles it.
  if (!ok) log.warn(`seek: warm did not settle — final url: ${finalUrl}`);
  return ok;
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
    // Decide by the SETTLED RENDER STATE — not a clock, not a transient URL. A
    // valid session NEVER renders the Auth0 login form on /talentsearch/search; an
    // EXPIRED one does, but the Turnstile-guarded form only appears at the END of
    // the /account/select → /oauth/* → authenticate.seek.com redirect chain, 15-30s
    // in. So wait up to 40s for the email field: if it renders → expired → log in;
    // if it provably does NOT render in that window → we're logged in → warm +
    // return. This fixes BOTH prior misreads: the 12s wait that gave up before the
    // slow form (skipped a needed login), AND the URL check that latched on a
    // transient /account/select mid-shuffle 4s in (the 2026-07-02 "SEEK no results":
    // authenticate skipped a login isSessionValid had ALREADY flagged as expired).
    // We treat no-form-appeared as valid rather than throwing, so a false-negative
    // isSessionValid can never trip the 2h circuit on a good session.
    const emailInput = page.locator('#emailAddress, input[name="emailAddress_hirer"], input[type="email"]').first();
    const needsLogin = await emailInput
      .waitFor({ state: "visible", timeout: 40_000 })
      .then(() => true)
      .catch(() => false);
    if (!needsLogin) {
      // "No login form" is NOT proof of a session. authenticate() runs in a
      // FRESH, cookie-less context, so a form that is merely slow (Turnstile,
      // cold network) looks identical to being logged in. The caller then saves
      // this context over seek.enc — writing an UNAUTHENTICATED state over a
      // good login, which is why the owner kept being signed out.
      //
      // Demand proof: warmSeekAccount must actually land on an authed app page.
      // If it does not, throw, so no session is saved and the file survives.
      const warmed = await warmSeekAccount(page).catch(() => false);
      if (!warmed) {
        throw new Error(
          `seek_challenge: no login form appeared and the session did not warm (${page.url()}) — ` +
          `refusing to save an unauthenticated context over the stored session`,
        );
      }
      log.info(`seek: no login form and scope warmed (${page.url()}) — session valid, skipping credential login`);
      return;
    }
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
    // Surface WHERE the login stalled. A bare "waitForURL: Timeout" classifies
    // as a soft/transient failure and keeps burning the retry budget, so an MFA
    // wall was retried dozens of times. Including the landing URL lets
    // classifyAuthFailure recognise authenticate.seek.com / mfa-otp-challenge as
    // HARD and stop after one attempt.
    try {
      await page.waitForURL(/(talent\.seek\.com\.au|employer\.seek\.com)(?!.*\/(login|oauth|sign-in))/, { timeout: 30_000 });
    } catch (waitErr) {
      throw new Error(
        `seek login did not settle (${waitErr instanceof Error ? waitErr.message : String(waitErr)}) — stalled at ${page.url()}`,
      );
    }
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
// Throttle only so we don't rewrite the encrypted file many times a minute.
// This is NOT a freshness policy — see below.
const SESSION_REFRESH_MS = 60 * 1000; // at most once a minute
async function rollSessionForward(platform: string, context: BrowserContext): Promise<void> {
  try {
    const p = sessionPath(platform);
    const ageMs = existsSync(p) ? Date.now() - statSync(p).mtimeMs : Infinity;
    // PERSIST EAGERLY. This gate used to be 3 hours, and that is what has been
    // forcing repeated SEEK OTPs.
    //
    // SEEK runs on Auth0, which ROTATES refresh tokens: every use mints a new
    // one and invalidates the previous. The worker restores the stored cookies,
    // uses them (rotating server-side), and — under a 3h gate — throws the new
    // tokens away. Measured 2026-08-12: the owner logged in at 11:43, the
    // worker ran SEEK jobs at 11:55 and 13:56, seek.enc was never rewritten,
    // and by 13:57 SEEK demanded an OTP. Any session used more than once inside
    // the window loses every rotation, so the stored token is dead on arrival.
    //
    // The real danger was never "saving too often" — it was saving a
    // LOGGED-OUT context over a good login. saveSession now refuses that
    // directly by checking for auth cookies, which is a precise guard. With
    // that in place, saving often is strictly protective: the freshest tokens
    // we have always reach disk.
    if (ageMs > SESSION_REFRESH_MS) {
      await saveSession(platform, context);
      log.info(`${platform}: session rolled forward (persisting rotated tokens; file was ${Math.round(ageMs / 1000)}s old)`);
    }
  } catch (err) {
    // Non-fatal — a failed refresh just means the session ages as before.
    log.warn(`${platform}: rolling session re-save failed (${err instanceof Error ? err.message : String(err)})`);
  }
}

/**
 * Platforms whose login requires a one-time passcode a human must type.
 *
 * For these the worker must NEVER attempt an automated login. It cannot succeed,
 * and the attempt runs in a fresh context that throws away the session the owner
 * just created by hand — turning one transient validity blip into a repeated
 * "log in again" loop for them.
 */
const MFA_PLATFORMS = new Set((process.env.MFA_PLATFORMS ?? "seek").split(",").map((p) => p.trim()).filter(Boolean));

export async function ensureSession(platform: string, browser: Browser): Promise<Page> {
  if (isCircuitOpen(authBreaker, platform, Date.now())) {
    // SELF-HEAL: a transient blip can trip the breaker while the session is
    // still VALID — without this, the 2h cooldown needlessly locks out a working
    // session (observed: a misread "session expired" → doomed Turnstile re-auth
    // → circuit OPEN → every SEEK job blocked for 2h on a perfectly valid
    // session, only cleared by a manual restart). Cheaply re-probe BEFORE
    // blocking: isSessionValid only navigates — it does NOT call authenticate() —
    // so it can't re-spam the login that opened the circuit. If the session is
    // actually fine, close the circuit and resume.
    if (hasSavedSession(platform)) {
      const { context, page } = await getPlatformPage(browser, platform);
      if (await isSessionValid(platform, page)) {
        authBreaker = recordAuthSuccess(authBreaker, platform);
        await rollSessionForward(platform, context);
        log.info(`${platform}: circuit was open but the session is valid — closing circuit, resuming`);
        return page;
      }
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

  if (hasSavedSession(platform)) {
    const { context, page } = await getPlatformPage(browser, platform);
    if (await isSessionValid(platform, page)) {
      authBreaker = recordAuthSuccess(authBreaker, platform);
      await rollSessionForward(platform, context);
      log.debug(`${platform}: session valid`);
      return page;
    }
    log.info(`${platform}: session expired, re-authenticating`);
  }

  // Platforms that demand a one-time passcode cannot be logged in by a worker.
  // Attempting it is pure downside: getPlatformPage({fresh:true}) below discards
  // the existing cookies, so a failed attempt DESTROYS whatever session the
  // owner had just established by hand — they reported re-logging in repeatedly
  // while this ran. Refuse instead: keep the context intact and ask for a human.
  if (MFA_PLATFORMS.has(platform)) {
    throw new Error(
      `${platform}_challenge: session invalid and ${platform} requires a one-time passcode — ` +
      `a worker cannot complete this. Run \`npx tsx login.ts ${platform}\` on the box. ` +
      `NOT attempting an automated login, which would discard the current session.`,
    );
  }

  try {
    // Re-login in a VIRGIN context (fresh: true): the expired context's stale
    // cookies/localStorage never leak into the login, so the session we save is
    // exactly the clean post-login state — same hygiene as a manual login.ts.
    const { context, page } = await getPlatformPage(browser, platform, { fresh: true });
    await authenticate(platform, page);
    await saveSession(platform, context);
    authBreaker = recordAuthSuccess(authBreaker, platform);
    return page;
  } catch (err) {
    const kind = classifyAuthFailure(err);
    authBreaker = recordAuthFailure(authBreaker, platform, kind, Date.now());
    const opened = isCircuitOpen(authBreaker, platform, Date.now());
    log.warn(
      `${platform}: re-auth ${kind} failure (${err instanceof Error ? err.message : String(err)})` +
        (opened ? " — circuit OPEN, pausing re-auth attempts for this platform" : " — will retry on next job"),
    );
    // The half-logged-in context is poisoned state — drop it so the next
    // attempt starts clean instead of deciding on top of a broken page.
    await discardPlatformSession(platform);
    throw err;
  }
}
