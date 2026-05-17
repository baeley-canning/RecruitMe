/**
 * Derive a candidate headline ("Title at Employer") from CV profileText.
 *
 * Why this exists: bulk JobAdder imports set the headline from CSV's
 * `currentPosition` + `currentEmployer`, which is sometimes a non-relevant
 * side gig (e.g. "High-Performance Coordinator at Kiwi Canoe Polo" instead
 * of "Junior Software Engineer at Integration Technologies Limited"). After
 * we extract the CV PDF into profileText we have the real picture; this
 * helper reads the most-recent role out of that text.
 *
 * The heuristic is intentionally conservative — pure function, no I/O, no
 * Prisma — so it's easy to test and easy to gate (callers compare the
 * derived headline to the existing one and only override when the existing
 * one obviously lacks a technical signal).
 */

/**
 * Word-boundary anchored "this looks like a job title" markers. Used both
 * to disambiguate "title vs. employer" (when one line clearly has a title
 * noun and the other doesn't) and as a sanity check on the final pick.
 * Order doesn't matter — these are alternation-joined into one regex.
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

/** Built once at module load. */
const TITLE_NOUN_RE = new RegExp(
  `\\b(?:${TITLE_NOUNS.join("|")})\\b`,
  "i",
);

/**
 * Section headers we treat as "the work history starts after this line".
 * All are matched case-insensitive on a stand-alone line (header line, not
 * a sentence). Order: longest / most-specific first, so "PROFESSIONAL
 * EXPERIENCE" wins over "EXPERIENCE" when both regexes would match.
 */
const SECTION_HEADERS = [
  /^\s*professional\s+experience\s*$/i,
  /^\s*work\s+experience\s*$/i,
  /^\s*employment\s+history\s*$/i,
  /^\s*career\s+history\s*$/i,
  /^\s*experience\s*$/i,
];

/**
 * Headers that mark the END of the work-experience section. If we hit one
 * before finding two non-blank lines, we bail.
 */
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

/**
 * Date-range trailers we strip from a title line. Matches forms like:
 *   "Junior Software Engineer    Jan. 2024 – Present"
 *   "Senior Developer 2020 - 2023"
 *   "Engineer (Jun 2019 – Dec 2021)"
 *   "Developer | 2018 to Present"
 * Anchored at end-of-string so a date inside a multi-word title isn't
 * accidentally chewed.
 *
 * The month token is anchored to a known set (Jan/Feb/.../Sept/December)
 * rather than "any 3-9 letter word", because [A-Za-z]{3,9} would happily
 * eat the role noun itself ("Engineer 2023" → "" — title gone).
 */
const MONTH_TOKEN =
  "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|January|February|March|April|June|July|August|September|October|November|December)\\.?";
const DATE_TRAILER_RE = new RegExp(
  `[\\s|·,(\\[-]+(?:${MONTH_TOKEN}\\s*)?\\d{4}\\s*(?:[–\\-—]+|to)?\\s*(?:(?:${MONTH_TOKEN}\\s*)?(?:\\d{4}|present|current|now))?\\)?\\]?\\s*$`,
  "i",
);

/**
 * Lone-token "Present" trailers — for CVs that put the start date in the
 * employer line and only "Present" on the title line. Defensive; cheap.
 */
const PRESENT_TRAILER_RE = /[\s|·,(\[-]+(?:present|current|now)\s*\)?\]?\s*$/i;

export interface DerivedHeadline {
  title: string;
  employer: string | null;
}

/**
 * Try to derive a headline from a CV's extracted text. Returns null when no
 * confident match is found — callers should leave the existing headline
 * alone in that case.
 *
 * Algorithm (top of the section is the most recent role by CV convention):
 *   1. Find the first WORK EXPERIENCE / EXPERIENCE / etc. section header.
 *   2. Skip blank lines after it.
 *   3. Collect the next two non-blank, non-stop-header lines.
 *   4. Decide which is the title line: whichever contains a TITLE_NOUNS
 *      match. If both do, take the first one (most CVs are title-first).
 *      If neither does, return null — we'd just be guessing.
 *   5. Strip date-range trailers from the title line.
 *   6. The other line is the employer (date trailer also stripped).
 */
export function deriveHeadlineFromCv(
  profileText: string,
): DerivedHeadline | null {
  if (!profileText || typeof profileText !== "string") return null;

  const lines = profileText.split(/\r?\n/);

  // Locate the section header.
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

  // Collect up to two candidate lines (skipping blanks, stopping at a
  // stop-header like "Education").
  const candidates: string[] = [];
  for (let i = headerIdx + 1; i < lines.length && candidates.length < 2; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (STOP_HEADERS.some((re) => re.test(trimmed))) break;
    // Skip a line that is itself another section header (defensive — some
    // CVs repeat the "Experience" header for a sub-section).
    if (SECTION_HEADERS.some((re) => re.test(trimmed))) continue;
    candidates.push(trimmed);
  }

  if (candidates.length === 0) return null;

  // Decide which line carries the title.
  const firstHasTitle  = TITLE_NOUN_RE.test(candidates[0]);
  const secondHasTitle =
    candidates.length > 1 && TITLE_NOUN_RE.test(candidates[1]);

  let titleLine: string;
  let employerLine: string | null;

  if (firstHasTitle) {
    // Default "title-first" layout (Bede-style).
    titleLine = candidates[0];
    employerLine = candidates[1] ?? null;
  } else if (secondHasTitle) {
    // Employer-first layout — second line is the role.
    titleLine = candidates[1];
    employerLine = candidates[0];
  } else {
    // Neither line looks like a job title — refuse rather than guess.
    return null;
  }

  const title    = cleanTitle(titleLine);
  const employer = employerLine ? cleanEmployer(employerLine) : null;

  if (!title) return null;

  // Re-verify after cleaning — the trailer-stripper shouldn't have eaten
  // the title noun, but if it did (e.g. "Engineer 2022" → ""), bail.
  if (!TITLE_NOUN_RE.test(title)) return null;

  return { title, employer };
}

/**
 * Strip date trailers and surrounding punctuation. Repeated apply: some
 * CVs stack date forms ("Engineer  Jan 2024 – Present  Auckland, NZ").
 */
function cleanTitle(raw: string): string {
  let s = raw.trim();
  // Run twice — first strip a date range, then strip a leftover location
  // trailer joined by " | " or ", ". We only strip when there's a clear
  // separator, so "Senior Software Engineer" stays intact.
  for (let i = 0; i < 2; i++) {
    s = s.replace(DATE_TRAILER_RE, "").trim();
    s = s.replace(PRESENT_TRAILER_RE, "").trim();
  }
  // Collapse runs of internal whitespace (PDF extracts often have 3-5
  // spaces between columns).
  s = s.replace(/\s{2,}/g, " ").trim();
  // Strip trailing punctuation left behind by the trailer removal.
  s = s.replace(/[\s|·,;:\-–—]+$/g, "").trim();
  return s;
}

function cleanEmployer(raw: string): string {
  let s = raw.trim();
  s = s.replace(DATE_TRAILER_RE, "").trim();
  s = s.replace(PRESENT_TRAILER_RE, "").trim();
  s = s.replace(/\s{2,}/g, " ").trim();
  s = s.replace(/[\s|·,;:\-–—]+$/g, "").trim();
  return s;
}

/**
 * Convenience: format a DerivedHeadline as the "Title at Employer" string
 * the Candidate.headline column expects. Falls back to bare title when
 * there's no employer.
 */
export function formatHeadline(d: DerivedHeadline): string {
  if (d.employer) return `${d.title} at ${d.employer}`;
  return d.title;
}

/**
 * "Looks correct" gate used by the extract + backfill scripts. If the
 * existing headline already mentions any technical-role keyword, we keep
 * it — the heuristic isn't strong enough to override a headline that's
 * already in the right ballpark.
 */
const PROTECTED_HEADLINE_KEYWORDS = [
  "Engineer", "Developer", "Programmer",
  "Analyst", "Architect", "DevOps",
  "Designer", "Lead",
];
const PROTECTED_HEADLINE_RE = new RegExp(
  `\\b(?:${PROTECTED_HEADLINE_KEYWORDS.join("|")})\\b`,
  "i",
);

export function existingHeadlineLooksCorrect(
  headline: string | null | undefined,
): boolean {
  if (!headline) return false;
  return PROTECTED_HEADLINE_RE.test(headline);
}
