/**
 * Strips recruiter-only annotations from profileText before AI insight
 * extraction. Critic A §4 demanded this: evidenceSnippets in ProfileInsight
 * are verbatim quotes from profileText, and historical recruiter habits
 * have put internal notes ("internal note: applicant disclosed migraines",
 * "HR concerned", "spoke to candidate") directly in the same field. If we
 * extract from un-sanitised text, those quotes leak across orgs the moment
 * an OrgAccessGrant viewer reads the insight.
 *
 * Design notes:
 *  • Line-level stripping only — we don't try to repair mid-line content.
 *    Recruiters write notes as separate lines almost universally, and
 *    surgical mid-line edits risk corrupting CV body text.
 *  • Conservative patterns — false negatives (a note slips through) are
 *    less harmful than false positives (a real CV bullet gets dropped).
 *    UI in PR 4 makes insight stale-detection visible so suspicion can be
 *    raised; an over-aggressive sanitiser would silently destroy data.
 *  • Returns `{ sanitised, droppedLines }` so callers can record how many
 *    lines were stripped (useful for telemetry and for warning when a
 *    suspiciously large fraction was removed).
 */

/**
 * Recruiter-note patterns. Each pattern is matched case-insensitively at
 * the start of a (trimmed) line. The line is dropped entirely if matched.
 *
 * Keep this list narrow and prefer obvious phrasings. False positives here
 * silently destroy CV content.
 */
const RECRUITER_NOTE_PATTERNS: RegExp[] = [
  /^internal note\s*[:.-]/i,
  /^recruiter note\s*[:.-]/i,
  /^private note\s*[:.-]/i,
  /^hr note\s*[:.-]/i,
  /^do not contact/i,
  /^do not approach/i,
  /^do not share/i,
  /^confidential\s*[:.-]/i,
  /^spoke (to|with) (the )?candidate/i,
  /^called (the )?candidate/i,
  /^hr (is |was )?concerned/i,
  /^red flag\s*[:.-]/i,
  /^reason for leaving (last role)?\s*[:.-]/i,
  /^salary expectation\s*[:.-]/i,
  /^notice period\s*[:.-]/i,
  /^availability\s*[:.-]/i,
  /^references provided/i,
  // Recruiter-bracket convention: lines starting with [NOTE], [PRIVATE], etc.
  /^\[(note|private|internal|recruiter|hr|confidential)\]/i,
];

export interface SanitiseResult {
  sanitised: string;
  /** Number of source lines that were removed. */
  droppedLines: number;
  /** Total source lines (post-split, pre-filter). For ratio telemetry. */
  totalLines: number;
}

export function sanitiseProfileTextForInsight(raw: string): SanitiseResult {
  if (!raw) {
    return { sanitised: "", droppedLines: 0, totalLines: 0 };
  }

  const lines = raw.split(/\r?\n/);
  const totalLines = lines.length;
  let droppedLines = 0;

  const kept = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return true; // blank lines preserved — they delimit sections
    for (const pat of RECRUITER_NOTE_PATTERNS) {
      if (pat.test(trimmed)) {
        droppedLines++;
        return false;
      }
    }
    return true;
  });

  return {
    sanitised: kept.join("\n"),
    droppedLines,
    totalLines,
  };
}

/**
 * Convenience predicate for tests / callers that just want to know whether
 * the text contains anything our sanitiser would strip.
 */
export function containsRecruiterAnnotations(raw: string): boolean {
  return sanitiseProfileTextForInsight(raw).droppedLines > 0;
}
