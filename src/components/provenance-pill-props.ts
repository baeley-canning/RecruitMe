/**
 * Pure decision helper for the candidate-card model-provenance badge.
 *
 * Lives in its own module (no React imports) so it can be unit-tested
 * without dragging in the full candidate-card JSX dependency tree.
 */

export interface ProvenancePillProps {
  label: "Claude" | "GPT";
  tone:  "claude" | "openai";
  title: string;
}

/**
 * Given a persisted scoredBy value and the badge context, return the
 * props to render — or null when there's nothing to show.
 *
 * Returns null for missing / legacy / unrecognised values so older
 * candidates (scored before scoredBy was tracked, or scored by a now-
 * removed provider like "ollama") render no provenance badge instead
 * of misleading the recruiter.
 */
export function provenancePillProps(
  source: "claude" | "openai" | undefined | null,
  context: "match" | "acceptance",
): ProvenancePillProps | null {
  if (source !== "claude" && source !== "openai") return null;
  if (source === "claude") {
    return {
      label: "Claude",
      tone:  "claude",
      title: context === "match"
        ? "Match score produced by Claude."
        : "Acceptance likelihood produced by Claude.",
    };
  }
  return {
    label: "GPT",
    tone:  "openai",
    title: context === "match"
      ? "Match score produced by OpenAI's GPT model (failover from Claude). Re-score when Claude is back if you want a Claude verdict."
      : "Acceptance likelihood produced by OpenAI's GPT model (failover from Claude). Re-run when Claude is back if you want a Claude verdict.",
  };
}
