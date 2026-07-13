/**
 * PDL Person Enrichment — fill blanks on a candidate we ALREADY have.
 *
 * This is the shortlist gap-fill path from docs/sourcing-engine-architecture.md:
 * a deliberate, per-candidate action (never bulk), that looks a known person up
 * on PDL by their LinkedIn URL / email and fills ONLY the fields we're missing.
 *
 * LIBRARY-SAFETY (enforced here + by the pure patch below):
 *  - Fill-only: a field is written ONLY when the candidate's current value is
 *    blank. Recruiter edits, captured profileText, and CVs always win.
 *  - CVs are never touched (this module knows nothing about CandidateFile).
 *  - Provenance-tagged (mergePdlProvenance) so a fill is attributable + reversible.
 *  - Never throws on the API: a miss/no-key/error returns a clean result the
 *    caller can report, not a 500.
 */

import { pdlPersonToText, type PDLPerson } from "./search";
import { recordProviderFailure, recordProviderSuccess } from "./provider-health";
import { safeParseJson } from "./utils";

/** PDL enrich returns a person plus contact arrays the search shape omits. */
interface PDLEnrichPerson extends PDLPerson {
  emails?: Array<{ address?: string } | string>;
  work_email?: string | null;
  personal_emails?: string[];
  phone_numbers?: string[];
  mobile_phone?: string | null;
}

export interface PdlEnrichResult {
  matched: boolean;
  /** Match confidence 0–10 as PDL reports it (likelihood), when matched. */
  likelihood: number | null;
  headline: string | null;
  location: string | null;
  email: string | null;
  phone: string | null;
  profileText: string | null;
}

const EMPTY: PdlEnrichResult = {
  matched: false, likelihood: null, headline: null, location: null,
  email: null, phone: null, profileText: null,
};

function firstEmail(p: PDLEnrichPerson): string | null {
  if (p.work_email) return p.work_email;
  if (p.personal_emails?.length) return p.personal_emails[0];
  const e = p.emails?.[0];
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && e.address) return e.address;
  return null;
}

function normalise(p: PDLEnrichPerson, likelihood: number | null): PdlEnrichResult {
  const headline = p.job_title
    ? (p.job_company_name ? `${p.job_title} at ${p.job_company_name}` : p.job_title)
    : null;
  const location = [p.location_locality, p.location_region, p.location_country]
    .filter(Boolean).join(", ") || null;
  const text = pdlPersonToText(p);
  return {
    matched: true,
    likelihood,
    headline: headline || null,
    location,
    email: firstEmail(p),
    phone: p.mobile_phone ?? p.phone_numbers?.[0] ?? null,
    profileText: text.trim().length > 0 ? text : null,
  };
}

/**
 * Look a known person up on PDL. Prefers LinkedIn URL (the strongest key), then
 * email. Returns {matched:false} on a clean miss, null only when PDL is
 * unconfigured (so the caller can 409 "no key").
 */
export async function enrichPersonFromPdl(params: {
  linkedinUrl?: string | null;
  email?: string | null;
  name?: string | null;
  minLikelihood?: number;
}): Promise<PdlEnrichResult | null> {
  const apiKey = process.env.PDL_API_KEY;
  if (!apiKey) return null;

  const qs = new URLSearchParams();
  if (params.linkedinUrl) qs.set("profile", params.linkedinUrl);
  else if (params.email) qs.set("email", params.email);
  else if (params.name) qs.set("name", params.name);
  else return { ...EMPTY };
  // Only accept confident matches — a weak name-only guess must not overwrite
  // blanks with the wrong person. PDL likelihood is 1–10; default floor 6.
  qs.set("min_likelihood", String(params.minLikelihood ?? 6));

  try {
    const res = await fetch(`https://api.peopledatalabs.com/v5/person/enrich?${qs.toString()}`, {
      headers: { "X-Api-Key": apiKey },
      signal: AbortSignal.timeout(15_000),
    });
    // 404 = the call succeeded but PDL has no confident match. That's a normal
    // outcome (green provider, no data), not a failure.
    if (res.status === 404) {
      recordProviderSuccess("pdl");
      return { ...EMPTY };
    }
    if (!res.ok) {
      recordProviderFailure("pdl", `enrich ${res.status} ${res.statusText}`);
      return { ...EMPTY };
    }
    const body = (await res.json()) as { status: number; likelihood?: number; data?: PDLEnrichPerson };
    recordProviderSuccess("pdl");
    if (!body.data) return { ...EMPTY };
    return normalise(body.data, typeof body.likelihood === "number" ? body.likelihood : null);
  } catch (err) {
    recordProviderFailure("pdl", err instanceof Error ? err.message : String(err));
    return { ...EMPTY };
  }
}

/** The candidate fields the fill-only patch can touch. */
export interface FillableCandidate {
  headline?: string | null;
  location?: string | null;
  email?: string | null;
  phone?: string | null;
  profileText?: string | null;
}

export interface FillOnlyPatch {
  /** Only the fields we're actually writing (all currently blank on the row). */
  patch: Partial<Record<"headline" | "location" | "email" | "phone" | "profileText", string>>;
  /** Human-readable names of the filled fields, for the toast + provenance. */
  filled: string[];
}

const blank = (v: string | null | undefined): boolean => !v || v.trim().length === 0;

/**
 * PURE fill-only merge: produce the patch of ONLY the blank fields PDL can fill.
 * profileText counts as "blank" when it's a stub (<200 chars) — a real captured
 * profile is never overwritten. Never returns a field the candidate already has.
 */
export function applyPdlFillOnly(candidate: FillableCandidate, e: PdlEnrichResult): FillOnlyPatch {
  const patch: FillOnlyPatch["patch"] = {};
  const filled: string[] = [];
  if (!e.matched) return { patch, filled };

  if (blank(candidate.headline) && e.headline) { patch.headline = e.headline; filled.push("headline"); }
  if (blank(candidate.location) && e.location) { patch.location = e.location; filled.push("location"); }
  if (blank(candidate.email) && e.email) { patch.email = e.email; filled.push("email"); }
  if (blank(candidate.phone) && e.phone) { patch.phone = e.phone; filled.push("phone"); }
  // profileText: fill only if the candidate has effectively none (stub/blank).
  if ((candidate.profileText?.trim().length ?? 0) < 200 && e.profileText) {
    patch.profileText = e.profileText;
    filled.push("profileText");
  }
  return { patch, filled };
}

/**
 * Merge PDL provenance into the candidate's existing screeningData JSON so a
 * fill is attributable (when + which fields) and later reversible — without a
 * schema migration. Preserves any existing screeningData keys (e.g. scoringError).
 */
export function mergePdlProvenance(
  existing: string | null,
  filled: string[],
  at: Date = new Date(),
): string {
  const obj = safeParseJson<Record<string, unknown>>(existing, {}) ?? {};
  obj.pdl = { enrichedAt: at.toISOString(), filled };
  return JSON.stringify(obj);
}
