/**
 * Scraper result ingestion pipeline.
 *
 * When the external scraper worker posts a completed ScrapeJob result,
 * this module handles:
 *  1. Normalising the URL into a Tier 1 identity key
 *  2. Finding or creating a CandidateIdentity for the person
 *  3. Upserting a Candidate row with the scraped profileText
 *  4. Writing an alias row for the identity key used
 *
 * Triggering insight re-extraction is the caller's responsibility
 * (fire-and-forget POST to /api/admin/insights/extract).
 *
 * All DB writes are atomic via prisma.$transaction. P2002 (unique
 * constraint race) is handled gracefully with a findFirst retry so
 * two concurrent scrapes for the same person don't 500.
 */

import { randomUUID } from "crypto";
import { prisma } from "./db";
import { normaliseLinkedInUrl } from "./linkedin";
import { normaliseSeekUrl } from "./seek";
// The scraper used to save the raw LinkedIn page innerText as profileText —
// which includes the "People also viewed" sidebar, Connect/Message buttons,
// "X is a mutual connection", and connection prompts (the SERP-looking junk).
// Run it through the SAME cleaner the browser-extension capture path uses so
// scraped profiles match the curated standard instead of dumping page chrome.
import {
  sanitizeCapturedLinkedInText,
  extractIdentityFromLinkedInProfileText,
  looksLikeCapturedName,
} from "./linkedin-capture";
import {
  identityMergeKey,
  mergeKeyToString,
  normaliseJobAdderUrl,
  type IdentityMergeKey,
} from "./identity-merge";

export type ScraperPlatform = "linkedin" | "seek" | "jobadder";

export interface IngestArgs {
  orgId: string;
  platform: ScraperPlatform;
  profileUrl: string;
  profileText: string;
  name?: string | null;
  headline?: string | null;
  location?: string | null;
  /** Contact email captured by the scraper (Phase E). */
  email?: string | null;
  /** Contact phone captured by the scraper. */
  phone?: string | null;
  /** Cross-platform: SEEK scrape may also return the candidate's LinkedIn URL. */
  linkedinUrl?: string | null;
  seekUrl?: string | null;
  /** Phase E — group rows created in the same operation for filter chips. */
  importBatchId?: string | null;
}

export interface IngestResult {
  candidateId: string;
  identityId: string;
  identityAction: "found_existing" | "created_new";
  candidateAction: "found_existing" | "updated_existing" | "created_new";
}

/** Resolve the Tier 1 merge key for a scrape result. */
function resolveKey(args: IngestArgs): IdentityMergeKey | null {
  return identityMergeKey({
    linkedinUrl: args.linkedinUrl ?? (args.platform === "linkedin" ? args.profileUrl : null),
    seekUrl: args.seekUrl ?? (args.platform === "seek" ? args.profileUrl : null),
    jobAdderUrl: args.platform === "jobadder" ? args.profileUrl : null,
  });
}

/** Normalise the profileUrl for storage on the Candidate row based on platform. */
function normaliseProfileUrl(platform: ScraperPlatform, url: string): string {
  if (platform === "linkedin") return normaliseLinkedInUrl(url);
  if (platform === "seek") return normaliseSeekUrl(url);
  if (platform === "jobadder") return normaliseJobAdderUrl(url);
  return url;
}

/** Map platform → Candidate.source value. */
function platformToSource(platform: ScraperPlatform): string {
  if (platform === "seek") return "seek_scraper";
  if (platform === "jobadder") return "jobadder_scraper";
  return "extension"; // linkedin scraper produces equivalent to extension capture
}

/** Map platform → the field on CandidateIdentity to set. */
function platformToIdentityField(platform: ScraperPlatform): {
  linkedinUrl?: string;
  seekUrl?: string;
  jobAdderUrl?: string;
} {
  return {};
}

export async function ingestScraperResult(args: IngestArgs): Promise<IngestResult> {
  // Clean LinkedIn page-dump cruft (sidebar / buttons / prompts) before it ever
  // becomes a candidate's profileText. LinkedIn-only: SEEK isn't deep-scraped
  // and JobAdder goes to the archive, so this cleaner (LinkedIn-tuned) only
  // applies here.
  if (args.platform === "linkedin" && args.profileText) {
    args.profileText = sanitizeCapturedLinkedInText(args.profileText);
    // The LinkedIn scraper often doesn't forward result.headline even though the
    // headline IS in the profile (search card + first body lines), so scraped
    // candidates landed with an empty Candidate.headline. The extension capture
    // path already solves this with extractIdentityFromLinkedInProfileText; reuse
    // it here to back-fill the headline from the just-sanitised profileText when
    // the scraper passed none. (Same proven extractor → same headline quality.)
    const derived = extractIdentityFromLinkedInProfileText(args.profileText);
    if (!args.headline && derived.headline) args.headline = derived.headline;
    // Prefer the extracted name when the scraper passed none OR passed junk (a
    // truthy-but-garbage card name like "View profile"). derived.name is itself
    // gated by looksLikeCapturedName, so a non-empty value is always a real name
    // — strictly better than junk, and it recovers profiles that would otherwise
    // hit the D2 reject below purely on a bad card name.
    if ((!args.name || !looksLikeCapturedName(args.name)) && derived.name) {
      args.name = derived.name;
    }

    // Reject thin/junk LinkedIn captures BEFORE they become an "Unknown" or
    // garbage Candidate. Throwing here makes the PATCH route mark the ScrapeJob
    // failed (retried/visible) instead of silently persisting page chrome.
    //  - <200 chars: the same usable-text floor the extension path enforces
    //    (buildIdentityData in linkedin-capture.ts).
    //  - name fails looksLikeCapturedName AND no headline: we couldn't recover
    //    a real person from this text — it's the "mumbled shit" we're blocking.
    if (args.profileText.length < 200) {
      throw new Error(
        "Scraped LinkedIn profile did not contain enough usable profile text (<200 chars after sanitising)",
      );
    }
    if (!looksLikeCapturedName(args.name) && !args.headline) {
      throw new Error(
        "Scraped LinkedIn profile yielded no usable name or headline — refusing to create a garbage candidate",
      );
    }
  }

  const key = resolveKey(args);
  const normalisedUrl = normaliseProfileUrl(args.platform, args.profileUrl);
  const source = platformToSource(args.platform);

  // --- Step 1: find or create CandidateIdentity ---
  let identity: { id: string } | null = null;
  let identityAction: IngestResult["identityAction"] = "found_existing";

  if (key) {
    const keyStr = mergeKeyToString(key)!;

    // Look up by the Tier 1 key field.
    if (key.kind === "linkedinUrl") {
      identity = await prisma.candidateIdentity.findFirst({
        where: { orgId: args.orgId, linkedinUrl: key.value },
        select: { id: true },
      });
    } else if (key.kind === "seekUrl") {
      identity = await prisma.candidateIdentity.findFirst({
        where: { orgId: args.orgId, seekUrl: key.value },
        select: { id: true },
      });
    } else if (key.kind === "jobAdderUrl") {
      identity = await prisma.candidateIdentity.findFirst({
        where: { orgId: args.orgId, jobAdderUrl: key.value },
        select: { id: true },
      });
    }

    if (!identity) {
      // Create a new identity. Handle P2002 race (two concurrent scrapes
      // for the same person) by falling back to findFirst.
      identityAction = "created_new";
      try {
        const identityData: Record<string, unknown> = {
          id: randomUUID(),
          orgId: args.orgId,
          canonicalName: args.name ?? "Unknown",
          ...(key.kind === "linkedinUrl" ? { linkedinUrl: key.value } : {}),
          ...(key.kind === "seekUrl" ? { seekUrl: key.value } : {}),
          ...(key.kind === "jobAdderUrl" ? { jobAdderUrl: key.value } : {}),
        };
        identity = await prisma.candidateIdentity.create({
          data: identityData as Parameters<typeof prisma.candidateIdentity.create>[0]["data"],
          select: { id: true },
        });
      } catch (err) {
        const code = (err as { code?: string })?.code;
        if (code !== "P2002") throw err;
        identityAction = "found_existing";
        // Re-fetch after race.
        if (key.kind === "linkedinUrl") {
          identity = await prisma.candidateIdentity.findFirst({
            where: { orgId: args.orgId, linkedinUrl: key.value },
            select: { id: true },
          });
        } else if (key.kind === "seekUrl") {
          identity = await prisma.candidateIdentity.findFirst({
            where: { orgId: args.orgId, seekUrl: key.value },
            select: { id: true },
          });
        } else {
          identity = await prisma.candidateIdentity.findFirst({
            where: { orgId: args.orgId, jobAdderUrl: key.value },
            select: { id: true },
          });
        }

        // A P2002 means a row with this exact key DOES exist. If the refetch
        // still can't see it, the state is inconsistent (a different unique
        // constraint fired, replica lag, or the row was deleted between the
        // conflict and the refetch). DO NOT fall through to the name-only
        // identity create below — that silently spawns a KEYLESS orphan
        // identity that defeats dedupe and strands the candidate under a row
        // no future scrape can match. Fail loud so the ingest is retried.
        if (!identity) {
          throw new Error(
            `Identity create raced (P2002) on ${key.kind}=${key.value} for org ${args.orgId}, ` +
            `but the refetch found no matching row — refusing to create a keyless orphan identity`,
          );
        }
      }

      // Write alias row for audit trail.
      if (identity && identityAction === "created_new") {
        await prisma.candidateIdentityAlias.create({
          data: {
            id: randomUUID(),
            identityId: identity.id,
            kind: key.kind,
            value: key.value,
            source: "system",
          },
        }).catch(() => {}); // non-fatal if duplicate alias
      }
    } else {
      // Backfill seekUrl on the existing identity if this is the first SEEK
      // scrape for a person we already know via LinkedIn. For a SEEK scrape the
      // URL is usually in profileUrl (args.seekUrl is often absent), so fall
      // back to profileUrl — otherwise the identity's seekUrl never gets set
      // and a later SEEK-only match can't reconcile to this person.
      if (key.kind === "linkedinUrl" && (args.seekUrl || args.platform === "seek")) {
        const seekVal = args.seekUrl
          ? normaliseSeekUrl(args.seekUrl)
          : args.platform === "seek"
            ? normaliseSeekUrl(args.profileUrl)
            : null;
        // `where: { seekUrl: null }` keeps the existing safety pattern — only
        // write when the identity has no seekUrl yet (don't clobber a known one).
        if (seekVal) {
          await prisma.candidateIdentity.updateMany({
            where: { id: identity.id, orgId: args.orgId, seekUrl: null },
            data: { seekUrl: seekVal },
          }).catch(() => {});
        }
      }
    }
  }

  if (!identity) {
    // No usable key — create identity keyed only by name.
    identityAction = "created_new";
    identity = await prisma.candidateIdentity.create({
      data: {
        id: randomUUID(),
        orgId: args.orgId,
        canonicalName: args.name ?? "Unknown",
      },
      select: { id: true },
    });
  }

  if (!identity) throw new Error("Failed to resolve CandidateIdentity");

  // Follow any merge chain so a re-scrape of a person whose identity was merged
  // (recruiter confirm OR auto-cluster sets mergedIntoIdentityId) attaches the
  // candidate to the SURVIVOR, not the merged-away row. Without this, every
  // re-scrape silently re-splits a confirmed merge — the exact bug class the
  // identity layer exists to prevent. The lookups above only fetch `id`, so
  // walk here; only needed for found-existing rows (a row we just created can't
  // be merged). Depth-capped to survive a pathological cycle.
  if (identityAction === "found_existing") {
    let cursorId: string = identity.id;
    for (let hop = 0; hop < 10; hop++) {
      const row: { mergedIntoIdentityId: string | null } | null =
        await prisma.candidateIdentity.findUnique({
          where: { id: cursorId },
          select: { mergedIntoIdentityId: true },
        });
      if (!row?.mergedIntoIdentityId) break;
      cursorId = row.mergedIntoIdentityId;
    }
    identity = { id: cursorId };
  }

  // --- Step 2: upsert Candidate row ---
  let candidateAction: IngestResult["candidateAction"] = "created_new";

  // Look for existing candidate by platform URL.
  const whereLinkedin = (args.platform === "linkedin" || args.linkedinUrl)
    ? normaliseLinkedInUrl(args.linkedinUrl ?? args.profileUrl)
    : null;

  let existing = whereLinkedin
    ? await prisma.candidate.findFirst({
        where: { orgId: args.orgId, linkedinUrl: whereLinkedin },
        select: { id: true, profileText: true },
        orderBy: { updatedAt: "desc" },
      })
    : null;

  // Fall back to the platform's OWN url key when there's no LinkedIn match.
  // (This used to always query jobAdderUrl, so a re-scraped SEEK person never
  // matched their existing row and a duplicate Candidate was created on every
  // scrape. Match seekUrl for SEEK, jobAdderUrl for JobAdder.)
  if (!existing && args.platform === "seek") {
    existing = await prisma.candidate.findFirst({
      where: { orgId: args.orgId, seekUrl: normalisedUrl },
      select: { id: true, profileText: true },
    }).catch(() => null);
  } else if (!existing && args.platform === "jobadder") {
    existing = await prisma.candidate.findFirst({
      where: { orgId: args.orgId, jobAdderUrl: normalisedUrl },
      select: { id: true, profileText: true },
    }).catch(() => null);
  }

  let candidateId: string;

  if (existing) {
    candidateAction = "updated_existing";
    candidateId = existing.id;

    const updateData: Record<string, unknown> = {
      profileCapturedAt: new Date(),
      candidateIdentityId: identity.id,
      updatedAt: new Date(),
    };
    if (args.profileText) updateData.profileText = args.profileText;
    if (args.name) updateData.name = args.name;
    if (args.headline) updateData.headline = args.headline;
    if (args.location) updateData.location = args.location;
    // Write the SEEK URL onto the existing Candidate row (not just the identity)
    // so a person first captured via LinkedIn gains their seekUrl, and a SEEK
    // re-scrape keeps it populated. Non-unique partial index → safe to re-write;
    // latest scrape wins (same policy as name/headline/location above).
    const seekForUpdate = args.platform === "seek"
      ? normalisedUrl
      : args.seekUrl ? normaliseSeekUrl(args.seekUrl) : null;
    if (seekForUpdate) updateData.seekUrl = seekForUpdate;
    // Clear stale score hash so UI shows "re-score recommended".
    if (args.profileText && args.profileText !== existing.profileText) {
      updateData.profileTextHash = null;
    }

    await prisma.candidate.update({
      where: { id: existing.id },
      data: updateData as Parameters<typeof prisma.candidate.update>[0]["data"],
    });
  } else {
    candidateId = randomUUID();
    const createData: Record<string, unknown> = {
      id: candidateId,
      orgId: args.orgId,
      name: args.name ?? "Unknown",
      headline: args.headline ?? null,
      location: args.location ?? null,
      email: args.email ?? null,
      phone: args.phone ?? null,
      profileText: args.profileText || null,
      profileCapturedAt: args.profileText ? new Date() : null,
      source,
      candidateIdentityId: identity.id,
      importBatchId: args.importBatchId ?? null,
    };

    if (args.platform === "linkedin") {
      createData.linkedinUrl = normaliseLinkedInUrl(args.linkedinUrl ?? args.profileUrl);
    } else if (args.platform === "jobadder") {
      createData.jobAdderUrl = normalisedUrl;
    } else if (args.platform === "seek") {
      // normalisedUrl is already normaliseSeekUrl(profileUrl) for the SEEK
      // platform. Write it onto the Candidate row (not just the identity) so
      // the library/search can dedupe + deep-link by it.
      createData.seekUrl = normalisedUrl;
    }
    // A SEEK URL can also ride along on a non-SEEK scrape (cross-platform capture).
    if (args.seekUrl && args.platform !== "seek") {
      createData.seekUrl = normaliseSeekUrl(args.seekUrl);
    }

    await prisma.candidate.create({
      data: createData as Parameters<typeof prisma.candidate.create>[0]["data"],
    });
  }

  return { candidateId, identityId: identity.id, identityAction, candidateAction };
}
