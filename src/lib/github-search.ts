import { recordProviderFailure, recordProviderSuccess } from "./provider-health";

/**
 * GitHub developer search.
 *
 * Uses the public GitHub REST API to find developers by location + language.
 * No scraping — this is a documented, free, ToS-compliant API.
 *
 * Rate limits:
 *   Unauthenticated:  60 requests/hour total
 *   Authenticated:    5000 requests/hour (30/min for search endpoint)
 *
 * Set GITHUB_TOKEN in Railway env vars to a personal access token
 * (github.com → Settings → Developer settings → Personal access tokens →
 * Fine-grained tokens → New token → no special scopes needed for public data).
 */

export interface GitHubUser {
  login:       string;
  name:        string | null;
  bio:         string | null;
  company:     string | null;
  location:    string | null;
  email:       string | null;
  blog:        string | null;          // often a personal site or LinkedIn URL
  avatarUrl:   string;
  githubUrl:   string;
  linkedinUrl: string | null;          // extracted from bio or blog field
  publicRepos: number;
  followers:   number;
  languages:   string[];               // top languages across public repos
  topRepos:    { name: string; description: string | null; language: string | null; stars: number }[];
  createdAt:   string;
  updatedAt:   string;
}

export interface GitHubSearchResult {
  users: GitHubUser[];
  total: number;
  rateLimitRemaining: number | null;
}

function getToken(): string | null {
  return process.env.GITHUB_TOKEN?.trim() || null;
}

function authHeaders(): HeadersInit {
  const token = getToken();
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "RecruitMe/1.0",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function extractLinkedInUrl(text: string | null): string | null {
  if (!text) return null;
  const m = text.match(/https?:\/\/(www\.)?linkedin\.com\/in\/[a-zA-Z0-9_-]+\/?/);
  return m ? m[0].replace(/\/$/, "") : null;
}

async function fetchUserDetail(login: string): Promise<{
  name: string | null;
  bio: string | null;
  company: string | null;
  location: string | null;
  email: string | null;
  blog: string | null;
  publicRepos: number;
  followers: number;
  createdAt: string;
  updatedAt: string;
}> {
  const res = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, {
    headers: authHeaders(),
    next: { revalidate: 3600 },
  });
  if (!res.ok) throw new Error(`GitHub user fetch failed: ${res.status}`);
  const d = await res.json();
  return {
    name:        d.name       ?? null,
    bio:         d.bio        ?? null,
    company:     d.company    ?? null,
    location:    d.location   ?? null,
    email:       d.email      ?? null,
    blog:        d.blog       ?? null,
    publicRepos: d.public_repos ?? 0,
    followers:   d.followers   ?? 0,
    createdAt:   d.created_at  ?? "",
    updatedAt:   d.updated_at  ?? "",
  };
}

async function fetchUserLanguages(login: string, maxRepos = 5): Promise<{
  languages: string[];
  topRepos: { name: string; description: string | null; language: string | null; stars: number }[];
}> {
  const res = await fetch(
    `https://api.github.com/users/${encodeURIComponent(login)}/repos?sort=pushed&per_page=${maxRepos}`,
    { headers: authHeaders(), next: { revalidate: 3600 } }
  );
  if (!res.ok) return { languages: [], topRepos: [] };
  const repos: Array<{
    name: string;
    description: string | null;
    language: string | null;
    stargazers_count: number;
    fork: boolean;
  }> = await res.json();

  const ownRepos = repos.filter((r) => !r.fork);
  const langCount: Record<string, number> = {};
  for (const r of ownRepos) {
    if (r.language) langCount[r.language] = (langCount[r.language] ?? 0) + 1;
  }
  const languages = Object.entries(langCount)
    .sort((a, b) => b[1] - a[1])
    .map(([lang]) => lang)
    .slice(0, 6);

  const topRepos = ownRepos.slice(0, 4).map((r) => ({
    name:        r.name,
    description: r.description,
    language:    r.language,
    stars:       r.stargazers_count,
  }));

  return { languages, topRepos };
}

export async function searchGitHubDevelopers(opts: {
  location:  string;
  languages: string[];
  maxResults?: number;
}): Promise<GitHubSearchResult> {
  const { location, languages, maxResults = 20 } = opts;

  // Build query: location + at least one language OR keyword match
  const locPart = `location:"${location}"`;
  const langPart = languages.length > 0
    ? languages.map((l) => `language:${encodeURIComponent(l)}`).join("+")
    : "";
  const q = [locPart, langPart].filter(Boolean).join("+");

  const searchUrl = `https://api.github.com/search/users?q=${q}&sort=joined&order=desc&per_page=${Math.min(maxResults, 30)}`;

  let searchRes: Response;
  try {
    searchRes = await fetch(searchUrl, {
      headers: authHeaders(),
      next: { revalidate: 300 }, // 5-min cache on search results
    });
  } catch (err) {
    recordProviderFailure("github", err instanceof Error ? err.message : String(err));
    throw err;
  }

  if (!searchRes.ok) {
    const body = await searchRes.text().catch(() => "");
    recordProviderFailure("github", `${searchRes.status} ${body.slice(0, 100)}`);
    if (searchRes.status === 403) throw new Error("GitHub rate limit exceeded — add a GITHUB_TOKEN to increase limits");
    throw new Error(`GitHub search failed: ${searchRes.status} ${body.slice(0, 200)}`);
  }
  recordProviderSuccess("github");

  const rateLimitRemaining = Number(searchRes.headers.get("x-ratelimit-remaining") ?? null) || null;
  const data = await searchRes.json() as { total_count: number; items: Array<{ login: string; avatar_url: string; html_url: string }> };

  // Enrich the top results in parallel — detail + languages for each
  const enriched = await Promise.allSettled(
    data.items.map(async (item) => {
      const [detail, { languages: langs, topRepos }] = await Promise.all([
        fetchUserDetail(item.login),
        fetchUserLanguages(item.login),
      ]);

      const linkedinUrl =
        extractLinkedInUrl(detail.blog) ??
        extractLinkedInUrl(detail.bio);

      return {
        login:       item.login,
        name:        detail.name,
        bio:         detail.bio,
        company:     detail.company,
        location:    detail.location,
        email:       detail.email,
        blog:        detail.blog,
        avatarUrl:   item.avatar_url,
        githubUrl:   item.html_url,
        linkedinUrl,
        publicRepos: detail.publicRepos,
        followers:   detail.followers,
        languages:   langs,
        topRepos,
        createdAt:   detail.createdAt,
        updatedAt:   detail.updatedAt,
      } satisfies GitHubUser;
    })
  );

  const users = enriched
    .filter((r): r is PromiseFulfilledResult<GitHubUser> => r.status === "fulfilled")
    .map((r) => r.value);

  return { users, total: data.total_count, rateLimitRemaining };
}

/** Build a candidate profileText from a GitHub user — same shape as a LinkedIn capture. */
export function githubUserToProfileText(user: GitHubUser): string {
  const lines: string[] = [];
  lines.push(user.name ?? user.login);
  if (user.company) lines.push(user.company);
  if (user.location) lines.push(user.location);
  if (user.email)   lines.push(user.email);
  lines.push("");
  if (user.bio) { lines.push("About"); lines.push(user.bio); lines.push(""); }
  if (user.languages.length > 0) {
    lines.push("Top Languages");
    lines.push(user.languages.join(", "));
    lines.push("");
  }
  if (user.topRepos.length > 0) {
    lines.push("Notable Repositories");
    for (const r of user.topRepos) {
      lines.push(`${r.name}${r.language ? ` (${r.language})` : ""}${r.description ? ` — ${r.description}` : ""}`);
    }
    lines.push("");
  }
  lines.push(`GitHub: ${user.githubUrl}`);
  if (user.linkedinUrl) lines.push(`LinkedIn: ${user.linkedinUrl}`);
  return lines.join("\n").trim();
}
