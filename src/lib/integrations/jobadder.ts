/**
 * JobAdder ATS integration.
 *
 * OAuth2 flow:
 *   1. Redirect user to JobAdder OAuth authorize URL
 *   2. JobAdder redirects back with ?code=
 *   3. Exchange code for access_token
 *   4. Store token in OrgSetting (key: "jobadder.access_token")
 *
 * Required env vars (set per org in settings, not globally):
 *   JOBADDER_CLIENT_ID, JOBADDER_CLIENT_SECRET
 *
 * Two-way sync:
 *   push: shortlisted/hired candidates → JobAdder application
 *   pull: new job orders → RecruitMe job
 */

export interface JobAdderCandidate {
  candidateId: number;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  summary?: string;
}

export interface JobAdderJob {
  jobId: number;
  title: string;
  companyName: string;
  location?: string;
  description?: string;
  status: "active" | "filled" | "closed";
}

export class JobAdderClient {
  private accessToken: string;
  private baseUrl = "https://api.jobadder.com/v2";

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
        ...(options?.headers ?? {}),
      },
    });
    if (!res.ok) {
      throw new Error(`JobAdder API error ${res.status}: ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  }

  async listJobs(status?: "active" | "filled" | "closed"): Promise<JobAdderJob[]> {
    const qs = status ? `?status=${status}` : "";
    const data = await this.request<{ items: JobAdderJob[] }>(`/jobs${qs}`);
    return data.items ?? [];
  }

  async getCandidate(candidateId: number): Promise<JobAdderCandidate> {
    return this.request<JobAdderCandidate>(`/candidates/${candidateId}`);
  }

  async addCandidateToJob(jobId: number, candidateId: number, note?: string): Promise<void> {
    await this.request(`/jobs/${jobId}/applications`, {
      method: "POST",
      body: JSON.stringify({ candidateId, note }),
    });
  }

  async updateApplicationStatus(
    jobId: number,
    applicationId: number,
    status: string,
  ): Promise<void> {
    await this.request(`/jobs/${jobId}/applications/${applicationId}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
  }
}

/** Build a JobAdder OAuth authorization URL. */
export function buildJobAdderAuthUrl(state: string): string {
  const clientId = process.env.JOBADDER_CLIENT_ID;
  if (!clientId) throw new Error("JOBADDER_CLIENT_ID not configured");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: `${process.env.NEXTAUTH_URL ?? ""}/api/integrations/jobadder/callback`,
    scope: "read write",
    state,
  });
  return `https://id.jobadder.com/connect/authorize?${params}`;
}

/** Exchange an authorization code for an access token. */
export async function exchangeJobAdderCode(code: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
}> {
  const clientId     = process.env.JOBADDER_CLIENT_ID;
  const clientSecret = process.env.JOBADDER_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("JobAdder credentials not configured");

  const res = await fetch("https://id.jobadder.com/connect/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: `${process.env.NEXTAUTH_URL ?? ""}/api/integrations/jobadder/callback`,
    }),
  });
  if (!res.ok) throw new Error(`JobAdder token exchange failed: ${await res.text()}`);
  return res.json();
}
