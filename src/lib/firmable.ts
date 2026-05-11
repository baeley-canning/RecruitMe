/**
 * Firmable People Enrichment client.
 *
 * Given a LinkedIn URL, looks up the candidate in Firmable and returns the
 * phone/email signals we care about. NZ/AU-focused enrichment provider; their
 * API supports ln_url directly so we don't need to munge slugs.
 *
 * Auth:    Authorization: Bearer fbl_xxx (via FIRMABLE_API_KEY env)
 * Endpoint: GET https://api.firmable.com/people?ln_url=<url>
 * Rate:    50 req/sec per key (we don't approach this, but withRetry handles
 *          transient 429s if a bulk-backfill ever does).
 *
 * Designed to fail soft: when the env var is missing, when the lookup 404s,
 * when the network is flaky — return null and let the caller move on. Phone
 * enrichment is a nice-to-have; the candidate record must save regardless.
 */

const FIRMABLE_BASE_URL = "https://api.firmable.com";
const FIRMABLE_TIMEOUT_MS = 8000;
// Skip re-enrichment within this window so a recruiter hitting "Enrich
// phones" twice in a row doesn't burn 2 credits per candidate. Firmable's
// data churns slowly enough that 90 days is plenty.
export const FIRMABLE_REFRESH_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export interface FirmablePhoneEntry {
  value: string;
  is_dnd?: boolean;
}

export interface FirmableEmailEntry {
  value: string;
  type?: string;
  deliverable?: boolean;
}

export interface FirmablePersonRaw {
  id?: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  headline?: string;
  location?: string;
  linkedin?: string;
  phones?: FirmablePhoneEntry[];
  emails?: FirmableEmailEntry[];
  current_company?: {
    name?: string;
    main_phones?: string[];
    other_phones?: string[];
    mobile_phones?: string[];
  };
  [key: string]: unknown;
}

export interface FirmableEnrichmentResult {
  /** Best phone to display: first non-DND personal mobile/work phone, then
   *  any non-DND number from current_company.mobile_phones, then any
   *  fallback. Null when no phones came back at all. */
  primaryPhone: string | null;
  /** Whether the primary phone is flagged DND. UI may dim it or show a warning. */
  primaryIsDnd: boolean;
  /** All personal phones (verbatim from `phones[]`). */
  personalPhones: FirmablePhoneEntry[];
  /** Best email to display, prefers deliverable. */
  primaryEmail: string | null;
  /** The full raw response (stored as JSON in firmableData for traceability). */
  raw: FirmablePersonRaw;
}

export class FirmableNotConfiguredError extends Error {
  constructor() {
    super("FIRMABLE_API_KEY is not set");
    this.name = "FirmableNotConfiguredError";
  }
}

/** Returns true if the env var is set — callers can pre-check before bulk runs. */
export function isFirmableConfigured(): boolean {
  return Boolean(process.env.FIRMABLE_API_KEY?.trim());
}

/**
 * Look up a person by LinkedIn URL. Returns null when:
 *   - the API key is not configured
 *   - the person isn't in Firmable's database (404)
 *   - the API returns an unexpected error after retries
 *
 * Throws only on FirmableNotConfiguredError (when callers explicitly want
 * to know about config gaps, e.g. the bulk-enrich endpoint).
 */
export async function enrichByLinkedIn(
  linkedinUrl: string,
  options: { signal?: AbortSignal; throwIfNotConfigured?: boolean } = {},
): Promise<FirmableEnrichmentResult | null> {
  const apiKey = process.env.FIRMABLE_API_KEY?.trim();
  if (!apiKey) {
    if (options.throwIfNotConfigured) throw new FirmableNotConfiguredError();
    return null;
  }
  if (!linkedinUrl?.trim()) return null;

  // Build the request URL — Firmable's `ln_url` accepts the full LinkedIn
  // URL verbatim. Encoding via URLSearchParams handles trailing slashes,
  // query strings, and Unicode in the slug.
  const url = new URL("/people", FIRMABLE_BASE_URL);
  url.searchParams.set("ln_url", linkedinUrl.trim());

  let controller: AbortController | null = null;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let signal = options.signal;
  if (!signal) {
    controller = new AbortController();
    signal = controller.signal;
    timeoutHandle = setTimeout(() => controller!.abort(), FIRMABLE_TIMEOUT_MS);
  }

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Accept": "application/json",
      },
      signal,
    });

    if (res.status === 404) {
      // Firmable doesn't have this person — common, not an error.
      return null;
    }
    if (res.status === 429) {
      // Rate limited. Callers driving bulk runs should slow down.
      console.warn("[firmable] 429 rate limited — caller should back off");
      return null;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[firmable] non-OK response ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }

    const raw = (await res.json()) as FirmablePersonRaw;
    return shapeResult(raw);
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") {
      console.warn(`[firmable] timeout after ${FIRMABLE_TIMEOUT_MS}ms for ${linkedinUrl}`);
      return null;
    }
    console.warn("[firmable] request failed:", err instanceof Error ? err.message : err);
    return null;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/** Pure shaping function — exported for testing. */
export function shapeResult(raw: FirmablePersonRaw): FirmableEnrichmentResult {
  const personalPhones = Array.isArray(raw.phones) ? raw.phones.filter(
    (p): p is FirmablePhoneEntry => Boolean(p && typeof p.value === "string" && p.value.trim()),
  ) : [];

  // Phone preference order:
  //   1. Non-DND personal phones (the recruiter can actually call these)
  //   2. DND personal phones (still useful for SMS / record-keeping; UI flags as DND)
  //   3. Company mobile phones
  //   4. Company main phones (last resort — likely a switchboard)
  const nonDndPersonal = personalPhones.find((p) => !p.is_dnd);
  const dndPersonal    = personalPhones.find((p) => p.is_dnd);
  const companyMobile  = raw.current_company?.mobile_phones?.find((v): v is string => Boolean(v?.trim()));
  const companyMain    = raw.current_company?.main_phones?.find((v): v is string => Boolean(v?.trim()));

  let primaryPhone: string | null = null;
  let primaryIsDnd = false;
  if (nonDndPersonal) {
    primaryPhone = nonDndPersonal.value;
  } else if (dndPersonal) {
    primaryPhone = dndPersonal.value;
    primaryIsDnd = true;
  } else if (companyMobile) {
    primaryPhone = companyMobile;
  } else if (companyMain) {
    primaryPhone = companyMain;
  }

  const deliverableEmail = (raw.emails ?? []).find(
    (e): e is FirmableEmailEntry => Boolean(e?.value) && e.deliverable !== false,
  );
  const fallbackEmail = (raw.emails ?? []).find(
    (e): e is FirmableEmailEntry => Boolean(e?.value),
  );

  return {
    primaryPhone,
    primaryIsDnd,
    personalPhones,
    primaryEmail: deliverableEmail?.value ?? fallbackEmail?.value ?? null,
    raw,
  };
}

/** True if a candidate's last enrichment is within the refresh window. */
export function isEnrichmentFresh(enrichedAt: Date | null | undefined): boolean {
  if (!enrichedAt) return false;
  return Date.now() - enrichedAt.getTime() < FIRMABLE_REFRESH_WINDOW_MS;
}
