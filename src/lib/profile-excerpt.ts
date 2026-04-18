const PROFILE_SECTION_ALIASES = new Map<string, string>([
  ["about", "About"],
  ["experience", "Experience"],
  ["education", "Education"],
  ["skills", "Skills"],
  ["top skills", "Top skills"],
  ["licenses certifications", "Licenses & certifications"],
  ["certifications", "Certifications"],
  ["courses", "Courses"],
  ["projects", "Projects"],
  ["publications", "Publications"],
  ["volunteering", "Volunteering"],
  ["honors awards", "Honors & awards"],
  ["summary", "Summary"],
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
  "Experience": 2200,
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

export const SCORE_PROFILE_EXCERPT_MAX_CHARS = 4500;
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
