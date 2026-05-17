/**
 * Smoke tests for searchGitHubDevelopers — the GitHub Users API integration.
 *
 * We mock globalThis.fetch with canned responses for:
 *   1. GET /search/users?q=...           → list of {login, avatar_url, html_url}
 *   2. GET /users/{login}                → user detail (name, bio, location, etc.)
 *   3. GET /users/{login}/repos          → repo list (language used for ranking)
 *
 * The point isn't to re-test GitHub itself; it's to assert our adapter:
 *   - dispatches the right URL shape (location + language filters land in `q`)
 *   - returns only the users from the search response (no extra fetches leak)
 *   - degrades gracefully on an empty search hit
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { searchGitHubDevelopers } from "@/lib/github-search";

type FetchInit = RequestInit | undefined;

interface FetchCannedResponse {
  ok?: boolean;
  status?: number;
  json: () => Promise<unknown>;
  text?: () => Promise<string>;
  headers?: { get: (k: string) => string | null };
}

function makeResponse(body: unknown, init: { status?: number; rateLimitRemaining?: string | null } = {}): FetchCannedResponse {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: (k: string) => (k.toLowerCase() === "x-ratelimit-remaining" ? init.rateLimitRemaining ?? "55" : null) },
  };
}

describe("searchGitHubDevelopers", () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns PHP developers when the language filter is set to PHP", async () => {
    // Search returns 3 candidates; we'll prove all 3 land in the result
    // and that the search URL embeds `language:PHP`.
    const searchBody = {
      total_count: 3,
      items: [
        { login: "phpdev1", avatar_url: "https://a/1", html_url: "https://github.com/phpdev1" },
        { login: "phpdev2", avatar_url: "https://a/2", html_url: "https://github.com/phpdev2" },
        { login: "phpdev3", avatar_url: "https://a/3", html_url: "https://github.com/phpdev3" },
      ],
    };

    const detailFor = (login: string) => ({
      login, name: login.toUpperCase(), bio: "PHP dev", company: null,
      location: "Auckland", email: null, blog: null,
      public_repos: 12, followers: 4, created_at: "2020-01-01", updated_at: "2024-01-01",
    });

    const reposFor = (login: string) => [
      { name: `${login}-laravel`, description: "Laravel app", language: "PHP", stargazers_count: 5, fork: false },
      { name: `${login}-utils`,   description: "Utility lib",  language: "PHP", stargazers_count: 2, fork: false },
    ];

    fetchMock.mockImplementation((url: string, _init: FetchInit) => {
      if (url.includes("/search/users")) return Promise.resolve(makeResponse(searchBody));
      const detailMatch = url.match(/users\/([^/?]+)$/);
      if (detailMatch) return Promise.resolve(makeResponse(detailFor(detailMatch[1])));
      const repoMatch = url.match(/users\/([^/]+)\/repos/);
      if (repoMatch) return Promise.resolve(makeResponse(reposFor(repoMatch[1])));
      return Promise.resolve(makeResponse({}, { status: 404 }));
    });

    const result = await searchGitHubDevelopers({ location: "Auckland", languages: ["PHP"] });

    expect(result.users).toHaveLength(3);
    expect(result.total).toBe(3);
    expect(result.users.map((u) => u.login)).toEqual(["phpdev1", "phpdev2", "phpdev3"]);
    // Sanity: PHP-only repos → PHP shows up in the user.languages list.
    expect(result.users.every((u) => u.languages.includes("PHP"))).toBe(true);

    // The search URL had to include the location + the language filter.
    const searchCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/search/users"));
    expect(searchCall).toBeDefined();
    expect(String(searchCall![0])).toContain("location");
    expect(String(searchCall![0])).toMatch(/language[:%]/i);
  });

  it("returns an empty user list when GitHub search yields zero results", async () => {
    const searchBody = { total_count: 0, items: [] };

    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes("/search/users")) return Promise.resolve(makeResponse(searchBody));
      // Detail/repo fetches should never fire on an empty search — fail loudly if they do.
      return Promise.resolve(makeResponse({}, { status: 500 }));
    });

    const result = await searchGitHubDevelopers({ location: "Wellington", languages: ["Rust"] });

    expect(result.users).toEqual([]);
    expect(result.total).toBe(0);
    // No follow-on fetches beyond the one search call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
