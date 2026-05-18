export type SearchResultStatus = "complete" | "rate_limited";

export type SearchResultSummary = {
  status?: SearchResultStatus;
  count: number;
  message?: string;
  fromPool?: number;
};

export function getSearchResultDisplay(result: SearchResultSummary): { tone: "success" | "warning"; message: string } {
  if (result.status === "rate_limited") {
    return {
      tone: "warning",
      message: result.message ?? (
        result.count > 0
          ? `Partial search found ${result.count} candidates before rate limiting. Run search again to continue.`
          : "Search was rate-limited before returning candidates. Wait a minute and run search again."
      ),
    };
  }

  if (result.count > 0) {
    return {
      tone: "success",
      message: result.fromPool && result.fromPool > 0
        ? `Found ${result.count} candidates — ${result.fromPool} from talent pool, ${result.count - result.fromPool} from LinkedIn`
        : `Found and imported ${result.count} candidates — scroll down to see them`,
    };
  }

  return {
    tone: "warning",
    message: result.message === "No profiles found."
      ? "No matching LinkedIn profiles found. Try: set Location to 'New Zealand', click Re-analyse to refresh search terms, or broaden requirements in the JD."
      : (result.message ?? "No new candidates found — they may already be imported, or try a broader location or JD."),
  };
}
