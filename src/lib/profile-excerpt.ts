import {
  extractSignalsFromRequirement,
  normalizeSignalText,
  signalMatchesText,
} from "./requirement-signals";

/**
 * Escape angle brackets and ampersands in user-supplied text before
 * injecting it inside XML tags in an AI prompt. Without this, a candidate
 * profile containing `</candidate_profile>` could close the safety wrapper
 * and inject instructions that the model would then execute.
 */
export function escapeXmlForPrompt(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const PROFILE_SECTION_ALIASES = new Map<string, string>([
  ["about", "About"],
  ["profile", "About"],
  ["summary", "Summary"],
  ["objective", "Summary"],
  // CV variants — keep first to preserve the "Experience" output key the
  // priority + limits maps below already understand.
  ["experience", "Experience"],
  ["work experience", "Experience"],
  ["professional experience", "Experience"],
  ["employment history", "Experience"],
  ["employment", "Experience"],
  ["work history", "Experience"],
  ["career history", "Experience"],
  ["career summary", "Experience"],
  ["education", "Education"],
  ["qualifications", "Education"],
  ["skills", "Skills"],
  ["technical skills", "Skills"],
  ["key skills", "Skills"],
  ["core competencies", "Skills"],
  ["top skills", "Top skills"],
  ["licenses certifications", "Licenses & certifications"],
  ["certifications", "Certifications"],
  ["courses", "Courses"],
  ["projects", "Projects"],
  ["publications", "Publications"],
  ["volunteering", "Volunteering"],
  ["honors awards", "Honors & awards"],
  ["references", "References"],
  ["achievements", "Achievements"],
  ["languages", "Languages"],
]);

const PROFILE_SECTION_PRIORITY = [
  "About",
  "Experience",
  "Education",
  "Top skills",
  "Skills",
  "Licenses & certifications",
  "Certifications",
  "Projects",
  "Courses",
  "Publications",
  "Volunteering",
  "Honors & awards",
  "Summary",
];

const PROFILE_SECTION_LIMITS: Record<string, number> = {
  "About": 1100,
  "Experience": 3800,
  "Education": 700,
  "Top skills": 500,
  "Skills": 500,
  "Licenses & certifications": 500,
  "Certifications": 500,
  "Projects": 700,
  "Courses": 450,
  "Publications": 450,
  "Volunteering": 450,
  "Honors & awards": 350,
  "Summary": 500,
};

export const SCORE_PROFILE_EXCERPT_MAX_CHARS = 6500;
export const OUTREACH_PROFILE_EXCERPT_MAX_CHARS = 3500;
export const ACCEPTANCE_PROFILE_EXCERPT_MAX_CHARS = 3500;

function normalizeSectionHeading(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function buildProfileExcerpt(profileText: string, maxChars: number): string {
  const cleaned = profileText.replace(/\r/g, "").trim();
  if (cleaned.length <= maxChars) return cleaned;

  const lines = cleaned
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const intro: string[] = [];
  const sections = new Map<string, string[]>();
  const otherBlocks: string[] = [];
  let currentSection: string | null = null;

  for (const line of lines) {
    const normalizedHeading = normalizeSectionHeading(line);
    const mappedHeading = PROFILE_SECTION_ALIASES.get(normalizedHeading);

    if (mappedHeading) {
      currentSection = mappedHeading;
      if (!sections.has(mappedHeading)) sections.set(mappedHeading, []);
      continue;
    }

    if (!currentSection) {
      if (intro.length < 12) intro.push(line);
      continue;
    }

    const bucket = sections.get(currentSection);
    if (bucket) bucket.push(line);
    else otherBlocks.push(line);
  }

  const chunks: string[] = [];
  let used = 0;

  const pushChunk = (chunk: string) => {
    const trimmed = chunk.trim();
    if (!trimmed || used >= maxChars) return;

    const remaining = maxChars - used;
    const clipped = trimmed.length > remaining ? trimmed.slice(0, remaining).trim() : trimmed;
    if (!clipped) return;

    chunks.push(clipped);
    used += clipped.length + 2;
  };

  pushChunk(intro.join("\n"));

  for (const heading of PROFILE_SECTION_PRIORITY) {
    const linesForSection = sections.get(heading);
    if (!linesForSection?.length) continue;

    const body = linesForSection.join("\n");
    const clippedBody = body.slice(0, PROFILE_SECTION_LIMITS[heading] ?? 500).trim();
    pushChunk(`${heading}\n${clippedBody}`);
  }

  const coveredSections = new Set(PROFILE_SECTION_PRIORITY);
  for (const [heading, sectionLines] of sections.entries()) {
    if (coveredSections.has(heading) || !sectionLines.length) continue;
    pushChunk(`${heading}\n${sectionLines.join("\n").slice(0, 500).trim()}`);
  }

  if (used < maxChars && otherBlocks.length > 0) {
    pushChunk(otherBlocks.join("\n"));
  }

  const excerpt = chunks.join("\n\n").trim();
  return excerpt.length > maxChars ? excerpt.slice(0, maxChars).trim() : excerpt;
}

function normalizeRequirementTerm(value: string) {
  return normalizeSignalText(value);
}

function extractRequirementTerms(requirements: string[]): string[] {
  const terms = new Set<string>();

  for (const requirement of requirements) {
    extractSignalsFromRequirement(requirement).forEach((term) => terms.add(normalizeRequirementTerm(term)));
  }

  return [...terms].filter((term) => term.length >= 2).slice(0, 24);
}

function lineIncludesTerm(line: string, term: string) {
  return signalMatchesText(line, term);
}

export function buildRequirementAwareProfileExcerpt(
  profileText: string,
  maxChars: number,
  requirements: string[]
): string {
  const baseline = buildProfileExcerpt(profileText, maxChars);
  if (!requirements.length || profileText.length <= maxChars) return baseline;

  const terms = extractRequirementTerms(requirements).filter((term) =>
    signalMatchesText(profileText, term) && !signalMatchesText(baseline, term)
  );
  if (terms.length === 0) return baseline;

  const lines = profileText
    .replace(/\r/g, "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const snippets: string[] = [];
  const seen = new Set<string>();
  for (const term of terms) {
    const index = lines.findIndex((line) => lineIncludesTerm(line, term));
    if (index === -1) continue;
    const start = Math.max(0, index - 2);
    const end = Math.min(lines.length, index + 7);
    const snippet = lines.slice(start, end).join("\n");
    const key = snippet.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    snippets.push(snippet);
  }

  if (snippets.length === 0) return baseline;

  const evidenceBlock = `Requirement evidence from full profile\n${snippets.join("\n\n")}`.slice(0, Math.min(1400, maxChars));
  const remaining = maxChars - evidenceBlock.length - 2;
  if (remaining <= 0) return evidenceBlock.slice(0, maxChars).trim();

  return `${baseline.slice(0, remaining).trim()}\n\n${evidenceBlock}`.slice(0, maxChars).trim();
}
