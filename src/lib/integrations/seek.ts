/**
 * SEEK job listing integration.
 *
 * Pulls live SEEK job ads into the RecruitMe listing builder.
 * Requires SEEK Partner API credentials (apply at talent.seek.com.au/partners).
 *
 * Required env vars: SEEK_CLIENT_ID, SEEK_CLIENT_SECRET
 *
 * Flow:
 *   1. GET /api/integrations/seek/search?q=... → returns SEEK job list
 *   2. GET /api/integrations/seek/job/:adId → returns full SEEK ad
 *   3. POST /api/jobs/new → creates job with parsedRole pre-populated from SEEK data
 */

export interface SeekJobSummary {
  adId: string;
  title: string;
  advertiserName: string;
  location: string;
  postedAt: string;
  expiresAt?: string;
  salary?: string;
}

export interface SeekJobDetail extends SeekJobSummary {
  description: string;
  requirements: string[];
  roleType: string;
  workType: string;
}

const SEEK_API_BASE = "https://api.seek.com.au/v2";

async function getSeekToken(): Promise<string> {
  const clientId     = process.env.SEEK_CLIENT_ID;
  const clientSecret = process.env.SEEK_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("SEEK credentials not configured");

  const res = await fetch("https://auth.seek.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      audience: "https://api.seek.com.au",
    }),
  });
  if (!res.ok) throw new Error(`SEEK token request failed: ${res.status}`);
  const data = await res.json() as { access_token: string };
  return data.access_token;
}

/** Search SEEK job ads by keyword and location. */
export async function searchSeekJobs(
  query: string,
  location?: string,
  limit = 20,
): Promise<SeekJobSummary[]> {
  const token = await getSeekToken();
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  if (location) params.set("location", location);

  const res = await fetch(`${SEEK_API_BASE}/jobs?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`SEEK search failed: ${res.status}`);
  const data = await res.json() as { data: SeekJobSummary[] };
  return data.data ?? [];
}

/** Fetch full details of a SEEK job ad. */
export async function getSeekJob(adId: string): Promise<SeekJobDetail> {
  const token = await getSeekToken();
  const res = await fetch(`${SEEK_API_BASE}/jobs/${adId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`SEEK job fetch failed: ${res.status}`);
  return res.json() as Promise<SeekJobDetail>;
}

/**
 * Convert a SEEK job detail to a raw JD string suitable for RecruitMe job parsing.
 * Keeps the source structure so the AI parser can extract structured data cleanly.
 */
export function seekJobToJd(job: SeekJobDetail): string {
  const lines: string[] = [
    `${job.title}`,
    `Company: ${job.advertiserName}`,
    `Location: ${job.location}`,
  ];
  if (job.salary) lines.push(`Salary: ${job.salary}`);
  lines.push("", job.description);
  if (job.requirements.length > 0) {
    lines.push("", "Requirements:", ...job.requirements.map((r) => `- ${r}`));
  }
  return lines.join("\n");
}
