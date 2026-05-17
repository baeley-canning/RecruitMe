/**
 * JS mirror of src/lib/cv-headline.ts for use by the .mjs backfill scripts.
 *
 * The TS version is the source of truth (it has the vitest suite). This
 * file MUST stay in sync — keep the regexes and exported function shapes
 * identical so a single fix-up doesn't drift between paths. If you change
 * one, change both and re-run `vitest run src/lib/__tests__/cv-headline`.
 *
 * Why duplicate? The scripts are plain ESM .mjs (no ts-node / tsx loader
 * standardised in this repo), and the helper is small enough that a port
 * is cheaper than wiring a TS runner into one-off backfill tooling.
 */

const TITLE_NOUNS = [
  "Engineer", "Engineering",
  "Developer", "Programmer",
  "Analyst",
  "Manager",
  "Designer",
  "Architect",
  "Specialist",
  "Consultant",
  "Scientist",
  "Coordinator",
  "Administrator",
  "Lead", "Leader",
  "Director",
  "Officer",
  "DevOps", "SRE",
  "Technician",
  "Researcher",
  "Intern",
  "Assistant",
  "Associate",
];
const TITLE_NOUN_RE = new RegExp(`\\b(?:${TITLE_NOUNS.join("|")})\\b`, "i");

const SECTION_HEADERS = [
  /^\s*professional\s+experience\s*$/i,
  /^\s*work\s+experience\s*$/i,
  /^\s*employment\s+history\s*$/i,
  /^\s*career\s+history\s*$/i,
  /^\s*experience\s*$/i,
];

const STOP_HEADERS = [
  /^\s*education\s*$/i,
  /^\s*skills\s*$/i,
  /^\s*technical\s+skills\s*$/i,
  /^\s*projects\s*$/i,
  /^\s*certifications?\s*$/i,
  /^\s*references\s*$/i,
  /^\s*publications\s*$/i,
  /^\s*awards\s*$/i,
  /^\s*languages\s*$/i,
  /^\s*interests\s*$/i,
  /^\s*hobbies\s*$/i,
];

const MONTH_TOKEN =
  "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|January|February|March|April|June|July|August|September|October|November|December)\\.?";
const DATE_TRAILER_RE = new RegExp(
  `[\\s|·,(\\[-]+(?:${MONTH_TOKEN}\\s*)?\\d{4}\\s*(?:[–\\-—]+|to)?\\s*(?:(?:${MONTH_TOKEN}\\s*)?(?:\\d{4}|present|current|now))?\\)?\\]?\\s*$`,
  "i",
);
const PRESENT_TRAILER_RE = /[\s|·,(\[-]+(?:present|current|now)\s*\)?\]?\s*$/i;

export function deriveHeadlineFromCv(profileText) {
  if (!profileText || typeof profileText !== "string") return null;
  const lines = profileText.split(/\r?\n/);

  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (SECTION_HEADERS.some((re) => re.test(trimmed))) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return null;

  const candidates = [];
  for (let i = headerIdx + 1; i < lines.length && candidates.length < 2; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (STOP_HEADERS.some((re) => re.test(trimmed))) break;
    if (SECTION_HEADERS.some((re) => re.test(trimmed))) continue;
    candidates.push(trimmed);
  }
  if (candidates.length === 0) return null;

  const firstHasTitle  = TITLE_NOUN_RE.test(candidates[0]);
  const secondHasTitle = candidates.length > 1 && TITLE_NOUN_RE.test(candidates[1]);

  let titleLine;
  let employerLine;
  if (firstHasTitle) {
    titleLine = candidates[0];
    employerLine = candidates[1] ?? null;
  } else if (secondHasTitle) {
    titleLine = candidates[1];
    employerLine = candidates[0];
  } else {
    return null;
  }

  const title    = cleanLine(titleLine);
  const employer = employerLine ? cleanLine(employerLine) : null;
  if (!title) return null;
  if (!TITLE_NOUN_RE.test(title)) return null;
  return { title, employer };
}

function cleanLine(raw) {
  let s = raw.trim();
  for (let i = 0; i < 2; i++) {
    s = s.replace(DATE_TRAILER_RE, "").trim();
    s = s.replace(PRESENT_TRAILER_RE, "").trim();
  }
  s = s.replace(/\s{2,}/g, " ").trim();
  s = s.replace(/[\s|·,;:\-–—]+$/g, "").trim();
  return s;
}

export function formatHeadline(d) {
  if (d.employer) return `${d.title} at ${d.employer}`;
  return d.title;
}

const PROTECTED_HEADLINE_KEYWORDS = [
  "Engineer", "Developer", "Programmer",
  "Analyst", "Architect", "DevOps",
  "Designer", "Lead",
];
const PROTECTED_HEADLINE_RE = new RegExp(
  `\\b(?:${PROTECTED_HEADLINE_KEYWORDS.join("|")})\\b`,
  "i",
);
export function existingHeadlineLooksCorrect(headline) {
  if (!headline) return false;
  return PROTECTED_HEADLINE_RE.test(headline);
}
