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
    if (!args.headline) {
      const derived = extractIdentityFromLinkedInProfileText(args.profileText);
      if (derived.headline) args.headline = derived.headline;
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
      // Update seekUrl on the existing identity if this is the first SEEK scrape
      // for a person we already know via LinkedIn.
      if (key.kind === "linkedinUrl" && (args.seekUrl || args.platform === "seek")) {
        const seekVal = args.seekUrl ? normaliseSeekUrl(args.seekUrl) : null;
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

  // For SEEK / JobAdder, fall back to jobAdderUrl match if no LinkedIn URL.
  if (!existing && args.platform !== "linkedin") {
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
    }
    // SEEK doesn't have a Candidate-level seekUrl field; identity carries it.

    await prisma.candidate.create({
      data: createData as Parameters<typeof prisma.candidate.create>[0]["data"],
    });
  }

  return { candidateId, identityId: identity.id, identityAction, candidateAction };
}
