import type { ScoreBreakdown } from "@/lib/scoring";
import type { RadarDimensions } from "../score-radar";

// Minimal candidate shape these helpers need. The CandidateCard's full
// Candidate type lives in the page; we only depend on a few fields here.
type CandidateLike = {
  source?: string | null;
  profileText?: string | null;
};

/**
 * Source-badge metadata for a candidate — both the human-readable label and
 * the Tailwind classes that distinguish sources visually (Phase E). Distinct
 * colours per source family so a recruiter scanning the library can spot at
 * a glance which candidates came from where:
 *
 *   blue   — LinkedIn (extension capture)
 *   orange — JobAdder (matches the JobAdder brand chip)
 *   green  — SEEK (matches the SEEK green)
 *   violet — internal talent pool
 *   cyan   — third-party APIs (SerpAPI / PDL)
 *   gray   — manual / generic scraper / unknown
 */
export function candidateSourceBadge(candidate: CandidateLike): { label: string; className: string } {
  const profileChars = candidate.profileText?.trim().length ?? 0;
  const NEUTRAL = "bg-surface-hover text-text-secondary";
  const LINKEDIN = "bg-accent-subtle text-accent";
  const JOBADDER = "bg-warning-subtle text-warning";
  const SEEK_CL = "bg-success-subtle text-success";
  const POOL = "bg-purple-subtle text-purple";
  const API_CL = "bg-info-subtle text-info";

  if (candidate.source === "extension") {
    if (profileChars > 0 && profileChars < 500)
      return { label: "LinkedIn partial capture", className: LINKEDIN };
    if (profileChars >= 500 && profileChars < 2000)
      return { label: "LinkedIn partial profile", className: LINKEDIN };
    return { label: "LinkedIn extension", className: LINKEDIN };
  }
  if (candidate.source === "bookmarklet") return { label: "LinkedIn capture", className: LINKEDIN };
  if (candidate.source === "talent_pool") return { label: "Talent pool", className: POOL };
  if (candidate.source === "pdl") return { label: "People Data Labs", className: API_CL };
  if (candidate.source === "serpapi") return { label: "LinkedIn search", className: API_CL }; // historical rows only
  if (candidate.source === "scraper") return { label: "LinkedIn (scraped)", className: LINKEDIN };
  if (candidate.source === "jobadder_import") return { label: "JobAdder import", className: JOBADDER };
  if (candidate.source === "jobadder_scraped") return { label: "JobAdder", className: JOBADDER };
  if (candidate.source === "seek") return { label: "SEEK", className: SEEK_CL };
  if (candidate.source === "seek_scraper") return { label: "SEEK", className: SEEK_CL };
  return {
    label: candidate.source ? candidate.source.replace(/_/g, " ") : "Manual",
    className: NEUTRAL,
  };
}

/** Backward-compatible label-only accessor — existing callers stay unchanged. */
export function candidateSourceLabel(candidate: CandidateLike): string {
  return candidateSourceBadge(candidate).label;
}

export function profileSourceSummary(candidate: CandidateLike) {
  const profileChars = candidate.profileText?.trim().length ?? 0;
  if (candidate.source === "extension") {
    if (profileChars > 0 && profileChars < 500) {
      return "The extension captured only a short partial profile. Fetch again before trusting the score.";
    }
    if (profileChars >= 500 && profileChars < 2000) {
      return "The extension captured a partial profile. Treat the score as provisional.";
    }
    return "Captured from the RecruitMe LinkedIn extension.";
  }
  if (candidate.source === "pdl") {
    return "Imported from People Data Labs and stored as structured profile text.";
  }
  if (!candidate.profileText) {
    return "No LinkedIn profile text has been stored yet.";
  }
  if ((candidate.source === "serpapi" || candidate.source === "scraper") && candidate.profileText.length < 500) {
    return "This is still only the search snippet, not the full LinkedIn capture.";
  }
  return `Stored from ${candidateSourceLabel(candidate).toLowerCase()}.`;
}

type LegacyRadarDimensions = Partial<RadarDimensions>;

export function getRadarDimensions(
  breakdown: ScoreBreakdown | null,
  legacyDimensions: LegacyRadarDimensions | undefined,
): RadarDimensions | null {
  if (breakdown) {
    return {
      skills: breakdown.categories.skill_fit.score,
      title: breakdown.categories.title_fit.score,
      industry: breakdown.categories.domain_fit?.score ?? breakdown.categories.industry_fit?.score ?? 50,
      location: breakdown.categories.location_fit.score,
      seniority: breakdown.categories.seniority_fit.score,
    };
  }

  if (!legacyDimensions) return null;

  return {
    skills: legacyDimensions.skills ?? 0,
    title: legacyDimensions.title ?? 0,
    industry: legacyDimensions.industry ?? 0,
    location: legacyDimensions.location ?? 0,
    seniority: legacyDimensions.seniority ?? 0,
  };
}

export function locationFitBadge(score: number | null | undefined) {
  if (score == null) {
    return {
      pill: "bg-surface-hover text-text-tertiary border-separator",
      icon: "text-text-tertiary",
      label: "Location unknown",
    };
  }
  if (score >= 75) {
    return {
      pill: "bg-success-subtle text-success border-separator",
      icon: "text-success",
      label: "Location fit",
    };
  }
  if (score >= 45) {
    return {
      pill: "bg-accent-subtle text-accent border-separator",
      icon: "text-accent",
      label: "Location maybe",
    };
  }
  return {
    pill: "bg-surface-hover text-text-secondary border-separator",
    icon: "text-text-tertiary",
    label: "Location mismatch",
  };
}

// Library imports without a real LinkedIn URL store a synthetic `library:src-*`
// key so the (jobId, linkedinUrl) unique constraint can dedupe re-imports.
// Return a clickable href ONLY for a genuine single-scheme linkedin.com URL.
// This rejects: synthetic keys (not http), non-LinkedIn URLs mis-filed into
// linkedinUrl (e.g. a SEEK talentsearch URL), and the mangled
// `https://www.linkedin.com/in/https://…seek…` values produced when a non-
// LinkedIn URL was normalised as a LinkedIn slug — all of which rendered as
// dead "This page doesn't exist" links.
export function displayableLinkedinUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const u = url.trim();
  if (!/^https?:\/\//i.test(u)) return null;            // synthetic key / internal
  if (/:\/\/[^\s]*:\/\//i.test(u)) return null;          // a second scheme embedded → mangled
  if (!/(^|\/\/|\.)linkedin\.com\//i.test(u)) return null; // only genuine LinkedIn hosts
  return u;
}
