/**
 * Pure decision helper for the candidate-card model-provenance badge.
 *
 * Lives in its own module (no React imports) so it can be unit-tested
 * without dragging in the full candidate-card JSX dependency tree.
 */

export interface ProvenancePillProps {
  label: "Claude" | "Llama";
  tone:  "claude" | "llama";
  title: string;
}

/**
 * Given a persisted scoredBy value and the badge context, return the
 * props to render — or null when there's nothing to show.
 *
 * Returns null for missing / legacy / unrecognised values so older
 * candidates (scored before scoredBy was tracked) render no provenance
 * badge instead of misleading the recruiter.
 */
export function provenancePillProps(
  source: "claude" | "ollama" | undefined | null,
  context: "match" | "acceptance",
): ProvenancePillProps | null {
  if (source !== "claude" && source !== "ollama") return null;
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
    label: "Llama",
    tone:  "llama",
    title: context === "match"
      ? "Match score produced by the local Llama model (failover from Claude). The score has been penalised to reflect lower confidence — re-score when Claude is back."
      : "Acceptance likelihood produced by the local Llama model (failover from Claude). Treat as provisional and re-run when Claude is back.",
  };
}
