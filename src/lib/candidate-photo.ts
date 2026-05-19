/**
 * Candidate avatar photo URL helper.
 *
 * We don't store candidate photos in the DB. Instead, when a candidate has a
 * real LinkedIn URL we passively resolve a photo via unavatar.io — a free
 * proxy that returns the public profile image for a given social slug.
 *
 * Why `?fallback=false`:
 *   Without this flag unavatar serves a generic placeholder on miss, which
 *   would look wrong next to our initials avatar. With it, misses return
 *   404 so the <img onError> handler can swap to initials cleanly.
 *
 * What this helper does NOT do:
 *   • No network call — pure URL construction.
 *   • No JobAdder URL support — JobAdder photos are gated behind their API.
 *   • No synthetic-library-key handling beyond returning null — those rows
 *     have no LinkedIn presence to fetch from.
 *
 * Slug extraction mirrors src/lib/linkedin.ts:normaliseLinkedInUrl so the two
 * stay in sync. We don't reuse it directly because we want only the slug,
 * not the full canonical LinkedIn URL.
 */

import { isSyntheticLibraryKey } from "./identity-merge";

const LINKEDIN_SLUG_RE = /linkedin\.com\/in\/([^/?#\s]+)/i;

export function getCandidatePhotoUrl(input: { linkedinUrl?: string | null }): string | null {
  const raw = input.linkedinUrl;
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (isSyntheticLibraryKey(trimmed)) return null;

  try {
    const match = trimmed.match(LINKEDIN_SLUG_RE);
    if (!match) return null;
    const slug = match[1]
      .replace(/[?#].*$/, "")
      .replace(/\/+$/, "")
      .toLowerCase()
      .trim();
    if (!slug) return null;
    return `https://unavatar.io/linkedin/${slug}?fallback=false`;
  } catch {
    return null;
  }
}
