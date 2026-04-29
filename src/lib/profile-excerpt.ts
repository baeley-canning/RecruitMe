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

const REQUIREMENT_TERM_ALIASES: Array<[RegExp, string[]]> = [
  [/\bpsybase\b/i, ["sybase"]],
  [/\bsybase\b/i, ["sybase", "sap sybase", "sql anywhere"]],
  [/\bc\+\+/i, ["c++"]],
  [/\bc sharp\b|\bc#/i, ["c#", "c sharp"]],
  [/\b\.net\b/i, [".net", "dotnet"]],
  [/\bjavascript\b|\bjs\b/i, ["javascript", "js"]],
  [/\btypescript\b/i, ["typescript"]],
  [/\blinux\b/i, ["linux"]],
  [/\bazure\b/i, ["azure", "microsoft azure"]],
  [/\bmicroservices?\b|\bminiservices?\b/i, ["microservice", "microservices", "miniservice", "miniservices"]],
];

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
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function extractRequirementTerms(requirements: string[]): string[] {
  const terms = new Set<string>();

  for (const requirement of requirements) {
    for (const [pattern, aliases] of REQUIREMENT_TERM_ALIASES) {
      if (pattern.test(requirement)) aliases.forEach((alias) => terms.add(normalizeRequirementTerm(alias)));
    }

    const explicitTech = requirement.match(/\b[A-Za-z][A-Za-z0-9.+#-]{1,}\b/g) ?? [];
    for (const token of explicitTech) {
      const lower = token.toLowerCase();
      if (
        token.length >= 3 &&
        !/^(and|the|with|from|that|this|have|has|experience|knowledge|ability|strong|software|database|development|programming|platform|platforms)$/.test(lower) &&
        (/[A-Z+#.]/.test(token) || /^(sybase|psybase|linux|azure|microservices?|miniservices?)$/i.test(token))
      ) {
        terms.add(normalizeRequirementTerm(lower === "psybase" ? "sybase" : token));
      }
    }
  }

  return [...terms].filter((term) => term.length >= 2).slice(0, 24);
}

function lineIncludesTerm(line: string, term: string) {
  const haystack = line.toLowerCase();
  if (term === "c++") return /\bc\+\+/i.test(line);
  if (term === "c#") return /\bc#/i.test(line);
  if (term === ".net") return /\.net\b/i.test(line);
  return haystack.includes(term);
}

export function buildRequirementAwareProfileExcerpt(
  profileText: string,
  maxChars: number,
  requirements: string[]
): string {
  const baseline = buildProfileExcerpt(profileText, maxChars);
  if (!requirements.length || profileText.length <= maxChars) return baseline;

  const terms = extractRequirementTerms(requirements).filter((term) =>
    profileText.toLowerCase().includes(term) && !baseline.toLowerCase().includes(term)
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
    const end = Math.min(lines.length, index + 3);
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
