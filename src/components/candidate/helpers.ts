import type { ScoreBreakdown } from "@/lib/scoring";
import type { RadarDimensions } from "../score-radar";

// Minimal candidate shape these helpers need. The CandidateCard's full
// Candidate type lives in the page; we only depend on a few fields here.
type CandidateLike = {
  source: string | null | undefined;
  profileText: string | null | undefined;
};

export function candidateSourceLabel(candidate: CandidateLike) {
  const profileChars = candidate.profileText?.trim().length ?? 0;
  if (candidate.source === "extension") {
    if (profileChars > 0 && profileChars < 500) return "LinkedIn partial capture";
    if (profileChars >= 500 && profileChars < 2000) return "LinkedIn partial profile";
    return "LinkedIn extension";
  }
  if (candidate.source === "talent_pool") return "Talent pool";
  if (candidate.source === "bookmarklet") return "LinkedIn capture";
  if (candidate.source === "pdl") return "People Data Labs";
  if (candidate.source === "serpapi") return "SerpAPI snippet";
  return candidate.source ? candidate.source.replace(/_/g, " ") : "Manual";
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
  if (candidate.source === "serpapi" && candidate.profileText.length < 500) {
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
// Anything not starting with http(s) is internal — never render as a link.
export function displayableLinkedinUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return /^https?:\/\//i.test(url) ? url : null;
}
