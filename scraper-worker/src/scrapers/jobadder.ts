/**
 * JobAdder scraper / API client.
 *
 * ── FOR AI HANDOFF ────────────────────────────────────────────────────────────
 * JobAdder has an official REST API at https://api.jobadder.com/v2.
 * If JOBADDER_ACCESS_TOKEN is set in .env, this module uses the API directly
 * (no browser needed for JobAdder). If not set, it falls back to Playwright.
 *
 * API AUTH: JobAdder uses OAuth2. The access token is relatively long-lived.
 * To get one:
 *   1. Use the OAuth flow in src/lib/integrations/jobadder.ts (already built)
 *   2. Copy the access_token from the callback
 *   3. Set JOBADDER_ACCESS_TOKEN in scraper-worker/.env
 *
 * The JobAdder API gives access to: candidates, jobs, applications, placements.
 * For scraping purposes we only need the candidates endpoint.
 *
 * IF API FAILS: Check token expiry. JobAdder tokens expire. Re-run the OAuth
 * flow and update JOBADDER_ACCESS_TOKEN in .env.
 *
 * RELATED: src/lib/integrations/jobadder.ts — Railway-side JobAdder client
 * (OAuth flow, push applications). The scraper-worker client here is separate
 * and read-only (candidate data only).
 */

import type { Page } from "playwright";
import { humanPagePause, humanMouseDrift, humanScroll, randomDelay } from "../humanizer";
import { LoginRequiredError } from "../util/retry";

const JA_BASE = "https://api.jobadder.com/v2";

export interface JobAdderCandidate {
  candidateId: string;
  name: string;
  headline: string;
  location: string;
  profileText: string; // assembled from API fields
}

/** Search JobAdder candidates. Prefers API; falls back to web scraping. */
export async function searchJobAdderCandidates(
  query: string,
  location: string,
  count: number,
  page: Page,
): Promise<JobAdderCandidate[]> {
  const token = process.env.JOBADDER_ACCESS_TOKEN;

  if (token) {
    return searchViaApi(token, query, location, count);
  }
  return searchViaWeb(query, location, count, page);
}

/** Fetch a single JobAdder candidate profile. */
export async function getJobAdderCandidate(
  candidateId: string,
  page: Page,
): Promise<JobAdderCandidate | null> {
  const token = process.env.JOBADDER_ACCESS_TOKEN;

  if (token) {
    return getViaApi(token, candidateId);
  }
  return getViaWeb(candidateId, page);
}

// ── API path ──────────────────────────────────────────────────────────────────

async function searchViaApi(
  token: string,
  query: string,
  location: string,
  count: number,
): Promise<JobAdderCandidate[]> {
  const params = new URLSearchParams({
    keywords: query,
    location,
    limit: String(Math.min(count, 50)),
  });

  const res = await fetch(`${JA_BASE}/candidates?${params}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });

  if (res.status === 401) throw new LoginRequiredError("jobadder: token expired");
  if (!res.ok) throw new Error(`JobAdder API error: ${res.status}`);

  const data = await res.json() as { items?: JobAdderApiCandidate[] };
  return (data.items ?? []).map(mapApiCandidate);
}

async function getViaApi(token: string, candidateId: string): Promise<JobAdderCandidate | null> {
  const res = await fetch(`${JA_BASE}/candidates/${candidateId}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });

  if (res.status === 404) return null;
  if (res.status === 401) throw new LoginRequiredError("jobadder: token expired");
  if (!res.ok) throw new Error(`JobAdder API error: ${res.status}`);

  const data = await res.json() as JobAdderApiCandidate;
  return mapApiCandidate(data);
}

interface JobAdderApiCandidate {
  candidateId?: number;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  currentEmployer?: string;
  currentPosition?: string;
  address?: { city?: string; state?: string; country?: string };
  summary?: string;
  skills?: string[];
  source?: string;
}

function mapApiCandidate(c: JobAdderApiCandidate): JobAdderCandidate {
  const name = [c.firstName, c.lastName].filter(Boolean).join(" ");
  const location = [c.address?.city, c.address?.state, c.address?.country].filter(Boolean).join(", ");
  const headline = [c.currentPosition, c.currentEmployer].filter(Boolean).join(" at ");

  const profileText = [
    name && `Name: ${name}`,
    c.currentPosition && `Current Role: ${c.currentPosition}`,
    c.currentEmployer && `Current Employer: ${c.currentEmployer}`,
    location && `Location: ${location}`,
    c.skills?.length && `Skills: ${c.skills.join(", ")}`,
    c.summary && `\nSummary:\n${c.summary}`,
  ].filter(Boolean).join("\n");

  return {
    candidateId: String(c.candidateId ?? ""),
    name,
    headline,
    location,
    profileText,
  };
}

// ── Web scraping fallback ─────────────────────────────────────────────────────

async function searchViaWeb(
  query: string,
  location: string,
  count: number,
  page: Page,
): Promise<JobAdderCandidate[]> {
  const url = `https://app.jobadder.com/candidates?keywords=${encodeURIComponent(query)}&location=${encodeURIComponent(location)}`;
  console.log(`[jobadder] Web search (no API token): ${url}`);

  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  await humanPagePause();

  if (page.url().includes("/login")) throw new LoginRequiredError("jobadder");

  await humanMouseDrift(page);
  await humanScroll(page, 1500);
  await randomDelay(800, 1500);

  // Generic extraction — JobAdder's UI is Angular-based, selectors may change
  const results = await page.evaluate((maxCount: number) => {
    const rows = Array.from(document.querySelectorAll(
      '[class*="candidate-row"], [class*="CandidateRow"], tr[data-id]'
    )).slice(0, maxCount);

    return rows.map((row) => {
      const nameEl = row.querySelector('[class*="name"], td:first-child');
      const headEl = row.querySelector('[class*="position"], [class*="title"]');
      const locEl  = row.querySelector('[class*="location"]');
      const link   = row.querySelector('a[href*="/candidates/"]');

      return {
        candidateId: (link?.getAttribute("href") ?? "").split("/").pop() ?? "",
        name:        (nameEl as HTMLElement)?.innerText?.trim() ?? "",
        headline:    (headEl as HTMLElement)?.innerText?.trim() ?? "",
        location:    (locEl as HTMLElement)?.innerText?.trim() ?? "",
        profileText: (nameEl as HTMLElement)?.innerText?.trim() ?? "",
      };
    }).filter((c) => c.name);
  }, count);

  await randomDelay(1500, 3000);
  return results;
}

async function getViaWeb(candidateId: string, page: Page): Promise<JobAdderCandidate | null> {
  const url = `https://app.jobadder.com/candidates/${candidateId}`;
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  await humanPagePause();

  if (page.url().includes("/login")) throw new LoginRequiredError("jobadder");

  await humanMouseDrift(page);

  const profileText = await page.evaluate(() => {
    const main = document.querySelector("main") ?? document.body;
    return (main as HTMLElement).innerText
      .split("\n").map((l: string) => l.trim()).filter((l: string) => l.length > 0).join("\n");
  });

  if (!profileText || profileText.length < 30) return null;

  const name     = await safeText(page, 'h1, [class*="candidate-name"]') ?? "";
  const headline = await safeText(page, '[class*="position"], [class*="title"]') ?? "";
  const location = await safeText(page, '[class*="location"]') ?? "";

  await randomDelay(1500, 3000);
  return { candidateId, name, headline, location, profileText };
}

async function safeText(page: Page, selector: string): Promise<string | null> {
  try {
    return await page.locator(selector).first().innerText({ timeout: 3000 });
  } catch {
    return null;
  }
}
