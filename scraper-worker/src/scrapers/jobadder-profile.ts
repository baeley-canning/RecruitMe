/**
 * JobAdder per-candidate scraper. Given a candidate URL, extracts the
 * structured fields (name, email, phone, location, current title/employer,
 * notes, attached files, photo) and writes them DIRECTLY to the
 * jobadder_archive Postgres DB + filesystem — *not* through RecruitMe.
 *
 * Selectors here are first-pass guesses against JobAdder's DOM. The first
 * dry-run on a real candidate will surface what's missing and we tune
 * selectors then — `rawJson` keeps the entire extraction blob in the
 * archive, so even when a specific column comes back null we have the
 * source-of-truth to rebuild from.
 *
 * File downloads use the same authenticated browser context (Patchright's
 * request API auto-includes session cookies) — JobAdder's attachment URLs
 * are same-origin authenticated endpoints, no separate token needed.
 */

import type { Page, BrowserContext } from "patchright";
import { humanScroll, randomDelay } from "../humanizer.js";
import { log } from "../util/log.js";
import {
  upsertArchiveCandidate,
  saveArchiveFile,
  saveArchiveNote,
  deleteArchiveNotesForCandidate,
  type FileCategory,
} from "../archive.js";

export interface JobAdderProfileResult {
  jobAdderId: string;
  fileCount: number;
  noteCount: number;
}

export async function scrapeJobAdderProfile(
  url: string,
  page: Page,
  context: BrowserContext,
): Promise<JobAdderProfileResult> {
  const jobAdderId = extractIdFromUrl(url);
  log.info(`jobadder-profile: ${url}`);

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await randomDelay(2_000, 4_000);

  const landed = page.url();
  if (
    !/\.jobadder\.com/.test(landed) ||
    /\/(SignIn|sign-in|signin|login|sso)/i.test(landed)
  ) {
    throw new Error(
      `JobAdder bounced to ${landed} for candidate ${jobAdderId} — session expired`,
    );
  }

  // Trigger lazy-loaded sections (work history, education, attachments).
  const pageHeight = await page.evaluate(() => document.body.scrollHeight);
  await humanScroll(page, pageHeight * 0.5);
  await randomDelay(800, 1_500);
  await humanScroll(page, pageHeight);
  await randomDelay(1_000, 2_000);

  const extracted = await page.evaluate(() => {
    const text = (sel: string) =>
      document.querySelector(sel)?.textContent?.trim() ?? null;

    const titleStr = (document.title ?? "")
      .replace(/\s*[|\-—]\s*JobAdder.*$/i, "")
      .trim();
    const titleName = titleStr.length > 0 ? titleStr : null;

    const name =
      text('[data-testid="candidate-name"]') ??
      text(".candidate-header h1") ??
      text("h1") ??
      titleName;

    const emailFromMailto = (() => {
      const a = document.querySelector('a[href^="mailto:"]') as HTMLAnchorElement | null;
      return a ? decodeURIComponent(a.href.replace(/^mailto:/, "").split("?")[0]) : null;
    })();
    const email =
      emailFromMailto ??
      text('[data-field="email"]') ??
      text('[data-testid="candidate-email"]');

    const phoneFromTel = (() => {
      const a = document.querySelector('a[href^="tel:"]') as HTMLAnchorElement | null;
      return a ? decodeURIComponent(a.href.replace(/^tel:/, "").split("?")[0]) : null;
    })();
    const phone =
      phoneFromTel ??
      text('[data-field="phone"]') ??
      text('[data-testid="candidate-phone"]');

    const location =
      text('[data-field="location"]') ??
      text('[data-testid="candidate-location"]') ??
      text(".candidate-location");
    const currentTitle =
      text('[data-field="current-title"]') ??
      text('[data-testid="current-title"]') ??
      text(".current-position");
    const currentEmployer =
      text('[data-field="current-employer"]') ??
      text('[data-testid="current-employer"]') ??
      text(".current-employer");

    const mainText =
      (document.querySelector("main, [role='main']") as HTMLElement)?.innerText ?? "";

    // Notes — try several selector patterns; tune at first dry-run.
    const noteNodes = Array.from(
      document.querySelectorAll(
        '[data-testid^="note"], .note-item, .candidate-note, [data-section="notes"] [data-note]',
      ),
    ) as HTMLElement[];
    const notes = noteNodes
      .map((n) => ({
        body: (n.innerText ?? "").trim(),
        author:
          (n.querySelector('[data-author]') as HTMLElement | null)?.textContent?.trim() ??
          (n.querySelector(".note-author") as HTMLElement | null)?.textContent?.trim() ??
          null,
      }))
      .filter((n) => n.body.length > 0);

    // Attachment download links — JobAdder uses /files/<id> or /attachments/<id>.
    const fileLinks = Array.from(
      document.querySelectorAll(
        'a[href*="/files/"], a[href*="/attachments/"], a[download][href^="http"]',
      ),
    ) as HTMLAnchorElement[];
    const files = fileLinks
      .filter((a) => /^https?:/.test(a.href))
      .map((a) => ({
        url: a.href,
        filename:
          a.getAttribute("download") ||
          decodeURIComponent(
            (a.href.split("/").pop() ?? "file").split("?")[0],
          ) ||
          "file",
      }));

    const photoEl = document.querySelector(
      'img.candidate-photo, [data-testid="candidate-avatar"] img, .avatar img',
    ) as HTMLImageElement | null;
    const photoUrl = photoEl?.src ?? null;

    return {
      name,
      email,
      phone,
      location,
      currentTitle,
      currentEmployer,
      profileText: mainText,
      notes,
      files,
      photoUrl,
    };
  });

  const profileText = synthesiseProfileText(extracted);

  await upsertArchiveCandidate({
    jobAdderId,
    name: extracted.name,
    email: extracted.email,
    phone: extracted.phone,
    location: extracted.location,
    currentTitle: extracted.currentTitle,
    currentEmployer: extracted.currentEmployer,
    profileText,
    jobAdderUrl: url,
    rawJson: extracted,
  });

  // Wipe and re-insert notes — keeps the archive in sync with the current
  // JobAdder state without needing stable note IDs.
  await deleteArchiveNotesForCandidate(jobAdderId);
  for (const note of extracted.notes) {
    await saveArchiveNote({ jobAdderId, author: note.author, body: note.body });
  }

  // Files — fetch each via the authenticated browser context (cookies attach
  // automatically). Dedup via dataHash makes re-runs cheap.
  let fileSaved = 0;
  for (const f of extracted.files) {
    try {
      const resp = await context.request.get(f.url, { timeout: 30_000 });
      if (!resp.ok()) {
        log.warn(`jobadder-profile: file ${f.url} -> ${resp.status()}`);
        continue;
      }
      const buf = Buffer.from(await resp.body());
      const mime = resp.headers()["content-type"] ?? "application/octet-stream";
      const result = await saveArchiveFile({
        jobAdderId,
        category: categoryFromMimeAndName(mime, f.filename),
        filename: f.filename,
        mimeType: mime,
        bytes: buf,
      });
      if (result.saved) fileSaved++;
    } catch (err) {
      log.warn(
        `jobadder-profile: file fetch failed ${f.url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Photo — same flow.
  if (extracted.photoUrl) {
    try {
      const resp = await context.request.get(extracted.photoUrl, { timeout: 15_000 });
      if (resp.ok()) {
        const buf = Buffer.from(await resp.body());
        const mime = resp.headers()["content-type"] ?? "image/jpeg";
        const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
        await saveArchiveFile({
          jobAdderId,
          category: "photo",
          filename: `photo.${ext}`,
          mimeType: mime,
          bytes: buf,
        });
      }
    } catch (err) {
      log.warn(`jobadder-profile: photo fetch failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  log.info(
    `jobadder-profile: ${jobAdderId} archived — ${fileSaved} new files, ${extracted.notes.length} notes, name="${extracted.name ?? "(none)"}"`,
  );
  return {
    jobAdderId,
    fileCount: fileSaved,
    noteCount: extracted.notes.length,
  };
}

function extractIdFromUrl(url: string): string {
  const m = url.match(/\/candidates\/([^/?#]+)/);
  if (!m) throw new Error(`Cannot extract JobAdder id from ${url}`);
  return m[1];
}

function categoryFromMimeAndName(mime: string, filename: string): FileCategory {
  const lower = filename.toLowerCase();
  if (mime.startsWith("image/")) return "photo";
  if (lower.includes("cover")) return "cover";
  if (lower.includes("cv") || lower.includes("resume")) return "cv";
  // PDFs / docs default to CV (most common JobAdder attachment).
  if (mime === "application/pdf" || lower.endsWith(".pdf") || lower.endsWith(".docx") || lower.endsWith(".doc")) return "cv";
  return "other";
}

function synthesiseProfileText(e: {
  name?: string | null;
  currentTitle?: string | null;
  currentEmployer?: string | null;
  location?: string | null;
  profileText?: string | null;
}): string {
  const parts: string[] = [];
  if (e.name) parts.push(e.name);
  const headline = [e.currentTitle, e.currentEmployer].filter(Boolean).join(" @ ");
  if (headline) parts.push(headline);
  if (e.location) parts.push(e.location);
  if (e.profileText) parts.push(e.profileText);
  return parts.join("\n").trim();
}
