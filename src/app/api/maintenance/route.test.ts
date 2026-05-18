import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
}));

const maintenanceMocks = vi.hoisted(() => ({
  purgeOldUsageEvents: vi.fn(),
  purgeExpiredLoginAttempts: vi.fn(),
  purgeOldSearchSessions: vi.fn(),
  purgeOldFetchSessions: vi.fn(),
  purgeOldJobParseHistory: vi.fn(),
}));

vi.mock("next-auth", () => authMocks);
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/maintenance", () => maintenanceMocks);

import { POST } from "./route";

describe("maintenance route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    maintenanceMocks.purgeOldUsageEvents.mockResolvedValue({ deleted: 1 });
    maintenanceMocks.purgeExpiredLoginAttempts.mockResolvedValue({ deleted: 2 });
    maintenanceMocks.purgeOldSearchSessions.mockResolvedValue({ deleted: 3 });
    maintenanceMocks.purgeOldFetchSessions.mockResolvedValue({ deleted: 4 });
    maintenanceMocks.purgeOldJobParseHistory.mockResolvedValue({ deleted: 5 });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows a valid cron secret without a NextAuth session", async () => {
    vi.stubEnv("MAINTENANCE_CRON_SECRET", "secret-123");
    authMocks.getServerSession.mockResolvedValue(null);

    const res = await POST(new Request("http://localhost/api/maintenance", {
      method: "POST",
      headers: { "x-cron-secret": "secret-123" },
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.deleted).toEqual({
      usage: 1,
      attempts: 2,
      searchSessions: 3,
      fetchSessions: 4,
      parseHistory: 5,
    });
    expect(authMocks.getServerSession).not.toHaveBeenCalled();
  });

  it("rejects missing or wrong cron secret unless the user is owner", async () => {
    vi.stubEnv("MAINTENANCE_CRON_SECRET", "secret-123");
    authMocks.getServerSession.mockResolvedValue({ user: { role: "user" } });

    const res = await POST(new Request("http://localhost/api/maintenance", {
      method: "POST",
      headers: { "x-cron-secret": "wrong" },
    }));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Owner only");
    expect(maintenanceMocks.purgeOldUsageEvents).not.toHaveBeenCalled();
  });

  it("still allows owner-initiated maintenance", async () => {
    authMocks.getServerSession.mockResolvedValue({ user: { role: "owner" } });

    const res = await POST(new Request("http://localhost/api/maintenance", { method: "POST" }));

    expect(res.status).toBe(200);
    expect(maintenanceMocks.purgeOldFetchSessions).toHaveBeenCalledTimes(1);
  });
});
