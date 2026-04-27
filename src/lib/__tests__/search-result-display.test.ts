import { describe, expect, it } from "vitest";
import { getSearchResultDisplay } from "../search-result-display";

describe("getSearchResultDisplay", () => {
  it("renders rate-limited search results as a warning", () => {
    expect(getSearchResultDisplay({
      status: "rate_limited",
      count: 3,
      message: "Found 3 candidates. Partially rate-limited — run again to find more.",
    })).toEqual({
      tone: "warning",
      message: "Found 3 candidates. Partially rate-limited — run again to find more.",
    });
  });

  it("renders completed searches as success", () => {
    expect(getSearchResultDisplay({
      status: "complete",
      count: 5,
      fromPool: 2,
    })).toEqual({
      tone: "success",
      message: "Found 5 candidates — 2 from talent pool, 3 from LinkedIn",
    });
  });
});
