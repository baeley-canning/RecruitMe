import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const aiMocks = vi.hoisted(() => ({
  parseJobDescription: vi.fn(),
}));

const sessionMocks = vi.hoisted(() => ({
  getAuth: vi.fn().mockResolvedValue({ userId: "user-1", orgId: "org-1", isOwner: false }),
  unauthorized: vi.fn(() => new Response(null, { status: 401 })),
}));

vi.mock("@/lib/ai", () => aiMocks);
vi.mock("@/lib/session", () => sessionMocks);

import { POST } from "./route";

describe("upload route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns raw text without invoking the job parser by default", async () => {
    const formData = new FormData();
    formData.append("file", new File(["Senior engineer brief"], "brief.txt", { type: "text/plain" }));

    const req = new Request("http://localhost/api/upload", {
      method: "POST",
      body: formData,
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.text).toBe("Senior engineer brief");
    expect(body.prefill).toBeUndefined();
    expect(aiMocks.parseJobDescription).not.toHaveBeenCalled();
  });

  it("returns prefill data for job-brief uploads", async () => {
    aiMocks.parseJobDescription.mockResolvedValue({
      title: "Senior Software Engineer",
      company: "Acme",
      location: "Wellington",
      location_rules: "Fully remote, NZ-based only",
      salary_band: "$110k-$140k NZD",
    });

    const formData = new FormData();
    formData.append("file", new File(["Senior engineer brief"], "brief.txt", { type: "text/plain" }));
    formData.append("mode", "job-brief");

    const req = new Request("http://localhost/api/upload", {
      method: "POST",
      body: formData,
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.text).toBe("Senior engineer brief");
    expect(body.prefill).toEqual({
      title: "Senior Software Engineer",
      company: "Acme",
      location: "Wellington",
      isRemote: true,
      salaryEnabled: true,
      salaryMin: 110000,
      salaryMax: 140000,
    });
  });

  it("still succeeds when prefill parsing fails", async () => {
    aiMocks.parseJobDescription.mockRejectedValue(new Error("model offline"));

    const formData = new FormData();
    formData.append("file", new File(["Senior engineer brief"], "brief.txt", { type: "text/plain" }));
    formData.append("mode", "job-brief");

    const req = new Request("http://localhost/api/upload", {
      method: "POST",
      body: formData,
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.text).toBe("Senior engineer brief");
    expect(body.prefill).toBeUndefined();
  });
});
