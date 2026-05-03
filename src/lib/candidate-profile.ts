export const FULL_PROFILE_MIN_CHARS = 2000;
export const CAPTURED_PROFILE_MIN_CHARS = 500;

export interface EvidenceValue {
  value?: unknown;
  evidence_quote?: unknown;
}

export interface EvidenceBullet {
  text?: unknown;
  evidence_quote?: unknown;
}

export interface EvidenceWorkItem {
  company?: EvidenceValue;
  role?: EvidenceValue;
  dates?: EvidenceValue;
  bullets?: EvidenceBullet[];
}

export interface EvidenceEducationItem {
  institution?: EvidenceValue;
  course?: EvidenceValue;
  year?: EvidenceValue;
}

export interface EvidenceSkillGroup {
  title?: EvidenceValue;
  skills?: EvidenceBullet[];
}

export interface EvidenceCandidateProfileDraft {
  candidate?: EvidenceValue;
  role?: EvidenceValue;
  dateAvailable?: EvidenceValue;
  executiveSummary?: EvidenceBullet[];
  skillGroups?: EvidenceSkillGroup[];
  workHistory?: EvidenceWorkItem[];
  educationTitle?: unknown;
  education?: EvidenceEducationItem[];
}

export interface SanitizedCandidateProfileDraft {
  candidate: string;
  role: string;
  dateAvailable: string;
  executiveSummary: string;
  skillGroups: Array<{ title: string; skills: string }>;
  workHistory: Array<{ company: string; role: string; dates: string; bullets: string }>;
  educationTitle: "Qualifications" | "Certifications";
  education: Array<{ institution: string; course: string; year: string }>;
  discardedUnsupportedFacts: number;
}

/** Returns true when a candidate row has a meaningful reusable profile. */
export function hasFullCandidateProfile(row: {
  profileCapturedAt: Date | string | null | undefined;
  profileText: string | null | undefined;
}): boolean {
  const charCount = row.profileText?.trim().length ?? 0;
  if (charCount >= FULL_PROFILE_MIN_CHARS) return true;
  return Boolean(row.profileCapturedAt && charCount >= CAPTURED_PROFILE_MIN_CHARS);
}

function cleanString(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function normalized(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function hasEvidence(sourceText: string, quote: unknown) {
  const cleaned = cleanString(quote);
  if (cleaned.length < 8) return false;
  return normalized(sourceText).includes(normalized(cleaned));
}

function supportedValue(sourceText: string, item: EvidenceValue | undefined, onDiscard: () => void) {
  const value = cleanString(item?.value);
  if (!value) return "";
  if (hasEvidence(sourceText, item?.evidence_quote)) return value;
  onDiscard();
  return "";
}

function supportedBullet(sourceText: string, item: EvidenceBullet | undefined, onDiscard: () => void) {
  const text = cleanString(item?.text);
  if (!text) return "";
  if (hasEvidence(sourceText, item?.evidence_quote)) return text;
  onDiscard();
  return "";
}

export function sanitizeCandidateProfileDraft(
  draft: EvidenceCandidateProfileDraft,
  sourceText: string
): SanitizedCandidateProfileDraft {
  let discardedUnsupportedFacts = 0;
  const discard = () => {
    discardedUnsupportedFacts += 1;
  };

  const skillGroups = Array.isArray(draft.skillGroups)
    ? draft.skillGroups
        .map((group) => ({
          title: supportedValue(sourceText, group.title, discard),
          skills: Array.isArray(group.skills)
            ? group.skills.map((skill) => supportedBullet(sourceText, skill, discard)).filter(Boolean).join("\n")
            : "",
        }))
        .filter((group) => group.title || group.skills)
    : [];

  const workHistory = Array.isArray(draft.workHistory)
    ? draft.workHistory
        .map((work) => ({
          company: supportedValue(sourceText, work.company, discard),
          role: supportedValue(sourceText, work.role, discard),
          dates: supportedValue(sourceText, work.dates, discard),
          bullets: Array.isArray(work.bullets)
            ? work.bullets.map((bullet) => supportedBullet(sourceText, bullet, discard)).filter(Boolean).join("\n")
            : "",
        }))
        .filter((work) => work.company || work.role || work.dates || work.bullets)
    : [];

  const education = Array.isArray(draft.education)
    ? draft.education
        .map((item) => ({
          institution: supportedValue(sourceText, item.institution, discard),
          course: supportedValue(sourceText, item.course, discard),
          year: supportedValue(sourceText, item.year, discard),
        }))
        .filter((item) => item.institution || item.course || item.year)
    : [];

  const educationTitle = draft.educationTitle === "Certifications" ? "Certifications" : "Qualifications";

  return {
    candidate: supportedValue(sourceText, draft.candidate, discard),
    role: supportedValue(sourceText, draft.role, discard),
    dateAvailable: supportedValue(sourceText, draft.dateAvailable, discard),
    executiveSummary: Array.isArray(draft.executiveSummary)
      ? draft.executiveSummary.map((sentence) => supportedBullet(sourceText, sentence, discard)).filter(Boolean).join("\n\n")
      : "",
    skillGroups,
    workHistory,
    educationTitle,
    education,
    discardedUnsupportedFacts,
  };
}
