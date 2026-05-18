/**
 * Google Sheets fetcher for the contact-sheet sync.
 *
 * Uses a service account (recommended over per-user OAuth for cron):
 *   1. Create a GCP project + service account, download the JSON key
 *   2. Share the sheet with the service account's email as Viewer
 *   3. Set GOOGLE_SERVICE_ACCOUNT_JSON env var to the full JSON string
 *   4. Set GOOGLE_SHEETS_SHEET_ID to the sheet's ID (from the URL)
 *
 * Returns rows keyed by tab name. Each tab is one job. Header row is
 * assumed and dropped. Column order MAY vary from sheet to sheet —
 * we resolve columns by header name (case-insensitive) so renaming or
 * re-ordering columns in the sheet doesn't break the sync.
 *
 * Required headers (any column order):
 *   - LinkedIn URL
 *   - Status
 * Optional headers (case-insensitive):
 *   - Candidate Name | Name
 *   - Company
 *   - Notes / Market Feedback | Notes
 *   - Owner
 *   - Last contacted
 */

import { google } from "googleapis";
import { parseLastContactedCell } from "./normalize";
import type { SheetRow } from "./types";

interface FetchOptions {
  sheetId: string;
  /** Service-account JSON as a parsed object OR raw string. */
  credentials: object | string;
  /** Tabs to skip entirely (case-insensitive). Default: ["Template"]. */
  skipTabs?: string[];
  /** Per-request timeout in ms (applies to each Sheets API call). Default 30s. */
  timeoutMs?: number;
}

/** Promise.race-based timeout. Doesn't truly abort the request (gaxios's signal
 *  support is version-dependent and unreliable), but guarantees the caller
 *  doesn't hang forever — which is the actual operational requirement here. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race<T>([
    p.finally(() => { if (timer) clearTimeout(timer); }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

export async function fetchAllTabs(opts: FetchOptions): Promise<Map<string, SheetRow[]>> {
  const credentials =
    typeof opts.credentials === "string"
      ? (JSON.parse(opts.credentials) as Record<string, unknown>)
      : (opts.credentials as Record<string, unknown>);

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  const sheets = google.sheets({ version: "v4", auth });
  const timeoutMs = opts.timeoutMs ?? 30_000;

  // List all tab names in the spreadsheet.
  const meta = await withTimeout(
    sheets.spreadsheets.get({ spreadsheetId: opts.sheetId }),
    timeoutMs,
    "Sheets metadata",
  );
  const tabNames = (meta.data.sheets ?? [])
    .map((s) => s.properties?.title ?? "")
    .filter(Boolean);

  const skip = new Set((opts.skipTabs ?? ["Template"]).map((t) => t.toLowerCase()));
  const result = new Map<string, SheetRow[]>();

  for (const tabName of tabNames) {
    if (skip.has(tabName.toLowerCase())) continue;
    const range = `'${tabName}'!A1:Z`;
    const resp = await withTimeout(
      sheets.spreadsheets.values.get({
        spreadsheetId: opts.sheetId,
        range,
      }),
      timeoutMs,
      `Sheets values for tab "${tabName}"`,
    );
    const values = resp.data.values ?? [];
    if (values.length < 2) continue; // header only or empty

    const [header, ...dataRows] = values;
    const col = buildHeaderIndex(header.map((c) => String(c ?? "")));
    if (col.linkedinUrl === -1 || col.status === -1) {
      // Missing required column — skip the whole tab.
      console.warn(`[contact-sheet] tab "${tabName}" is missing LinkedIn URL / Status column — skipping`);
      continue;
    }

    const rows: SheetRow[] = [];
    dataRows.forEach((row, i) => {
      const rowNumber = i + 2; // 1-indexed + skipped header row
      const linkedinUrl = String(row[col.linkedinUrl] ?? "").trim();
      const status      = String(row[col.status] ?? "").trim();
      // Empty rows are common at the bottom of sheets — drop them outright.
      if (!linkedinUrl && !status) return;
      rows.push({
        rowNumber,
        linkedinUrl,
        status,
        candidateName: col.candidateName !== -1 ? (String(row[col.candidateName] ?? "").trim() || null) : null,
        company:       col.company       !== -1 ? (String(row[col.company]       ?? "").trim() || null) : null,
        notes:         col.notes         !== -1 ? (String(row[col.notes]         ?? "").trim() || null) : null,
        owner:         col.owner         !== -1 ? (String(row[col.owner]         ?? "").trim() || null) : null,
        lastContacted: col.lastContacted !== -1 ? parseLastContactedCell(String(row[col.lastContacted] ?? "")) : null,
      });
    });
    if (rows.length > 0) result.set(tabName, rows);
  }

  return result;
}

/** Map column name → index in the header row. -1 if missing. */
function buildHeaderIndex(header: string[]): Record<
  "linkedinUrl" | "status" | "candidateName" | "company" | "notes" | "owner" | "lastContacted",
  number
> {
  const find = (...candidates: string[]) => {
    const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ");
    const wanted = candidates.map(norm);
    return header.findIndex((h) => wanted.includes(norm(h)));
  };
  return {
    linkedinUrl:   find("linkedin url", "linkedin", "profile url", "url"),
    status:        find("status"),
    candidateName: find("candidate name", "name", "candidate"),
    company:       find("company", "current company", "employer"),
    notes:         find("notes  market feedback", "notes / market feedback", "notes market feedback", "notes", "market feedback", "comment", "comments"),
    owner:         find("owner", "recruiter"),
    lastContacted: find("last contacted", "contacted at", "contact date", "date contacted", "last contact"),
  };
}
