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
      pill: "bg-slate-100 text-slate-500 border-slate-200",
      icon: "text-slate-400",
      label: "Location unknown",
    };
  }
  if (score >= 75) {
    return {
      pill: "bg-emerald-50 text-emerald-700 border-emerald-200",
      icon: "text-emerald-600",
      label: "Location fit",
    };
  }
  if (score >= 45) {
    return {
      pill: "bg-blue-50 text-blue-700 border-blue-200",
      icon: "text-blue-600",
      label: "Location maybe",
    };
  }
  return {
    pill: "bg-red-50 text-red-700 border-red-200",
    icon: "text-red-600",
    label: "Location mismatch",
  };
}
