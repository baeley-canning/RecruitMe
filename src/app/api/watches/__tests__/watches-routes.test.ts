/**
 * Route tests for Profile-Update Alerts (Stages C + E).
 *
 * Pins the invariants that must never silently break:
 *   • flag-gating — every /api/watches route 404s when FEATURES_PROFILE_WATCH_ENABLED
 *     is off; run-due ALSO 404s unless the scheduler flag is on too.
 *   • org-isolation — a watch is created under the caller's org; PATCH/DELETE/check
 *     resolve the watch by (id, orgId), so another org's id 404s.
 *   • interval clamp — sub-floor intervalMinutes is rejected 422 (POST + PATCH).
 *   • run-due — cron-secret auth (timing-safe; wrong/absent → 401) and the
 *     app-side WATCH_DAILY_CAP skips due watches once today's budget is spent.
 *
 * All DB / session / feature-flag / watched-search interaction is mocked — no
 * real Prisma. We mock the watched-search lib helpers the ROUTES call (the lib
 * itself has its own coverage); these tests assert the route plumbing:
 * gating, org-scoping args, validation, auth, and the cap arithmetic.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// ── mocks ────────────────────────────────────────────────────────────────────

const dbMocks = vi.hoisted(() => ({
  prisma: {
    searchRun: { count: vi.fn() },
    watchedSearch: { findMany: vi.fn() },
  },
}));

const sessionMocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  unauthorized: vi.fn(() => new Response(null, { status: 401 })),
}));

const watchedSearchMocks = vi.hoisted(() => ({
  createWatch: vi.fn(),
  listWatches: vi.fn(),
  updateWatch: vi.fn(),
  deleteWatch: vi.fn(),
  getWatch: vi.fn(),
  enqueueWatchCheck: vi.fn(),
  // Real interval clamp bounds — the route schema reads these for its zod min/max.
  MIN_INTERVAL_MINUTES: 30,
  MAX_INTERVAL_MINUTES: 1440,
}));

// Capture pre-existing flag values so afterAll can restore them — otherwise
// "true" leaks into whatever test file runs next in this worker.
const ORIGINAL = vi.hoisted(() => {
  const feat = process.env.FEATURES_PROFILE_WATCH_ENABLED;
  const sched = process.env.FEATURES_PROFILE_WATCH_SCHEDULER_ENABLED;
  const cap = process.env.WATCH_DAILY_CAP;
  const cron = process.env.CONTACT_SYNC_CRON_SECRET;
  return { feat, sched, cap, cron };
});

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/session", () => sessionMocks);
vi.mock("@/lib/watched-search", () => watchedSearchMocks);

import { GET as listGET, POST as createPOST } from "@/app/api/watches/route";
import { PATCH as watchPATCH, DELETE as watchDELETE } from "@/app/api/watches/[id]/route";
import { POST as checkPOST } from "@/app/api/watches/[id]/check/route";
import { POST as runDuePOST } from "@/app/api/watches/run-due/route";

const NON_OWNER = { userId: "u1", orgId: "org-A", isOwner: false };
const OTHER_ORG = { userId: "u2", orgId: "org-B", isOwner: false };

const CRON_SECRET = "cron-secret-xyz";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FEATURES_PROFILE_WATCH_ENABLED = "true";
  process.env.FEATURES_PROFILE_WATCH_SCHEDULER_ENABLED = "true";
  process.env.CONTACT_SYNC_CRON_SECRET = CRON_SECRET;
  delete process.env.WATCH_DAILY_CAP; // default 40 unless a test sets it
  sessionMocks.getAuth.mockResolvedValue(NON_OWNER);
});

afterAll(() => {
  const restore = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  restore("FEATURES_PROFILE_WATCH_ENABLED", ORIGINAL.feat);
  restore("FEATURES_PROFILE_WATCH_SCHEDULER_ENABLED", ORIGINAL.sched);
  restore("WATCH_DAILY_CAP", ORIGINAL.cap);
  restore("CONTACT_SYNC_CRON_SECRET", ORIGINAL.cron);
});

const json = (url: string, method = "GET", body?: unknown, headers?: Record<string, string>) =>
  new Request(url, {
    method,
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const params = (id: string) => ({ params: Promise.resolve({ id }) });

// ── flag-gating ────────────────────────────────────────────────────────────

describe("flag-gating — every watches route 404s when the feature flag is off", () => {
  beforeEach(() => {
    process.env.FEATURES_PROFILE_WATCH_ENABLED = "false";
  });

  it("GET /api/watches", async () => {
    expect((await listGET()).status).toBe(404);
    expect(watchedSearchMocks.listWatches).not.toHaveBeenCalled();
  });

  it("POST /api/watches", async () => {
    const res = await createPOST(json("http://t/api/watches", "POST", { name: "x", query: "react" }));
    expect(res.status).toBe(404);
    expect(watchedSearchMocks.createWatch).not.toHaveBeenCalled();
  });

  it("PATCH /api/watches/[id]", async () => {
    const res = await watchPATCH(json("http://t/api/watches/w1", "PATCH", { name: "y" }), params("w1"));
    expect(res.status).toBe(404);
    expect(watchedSearchMocks.updateWatch).not.toHaveBeenCalled();
  });

  it("DELETE /api/watches/[id]", async () => {
    const res = await watchDELETE(json("http://t/api/watches/w1", "DELETE"), params("w1"));
    expect(res.status).toBe(404);
    expect(watchedSearchMocks.deleteWatch).not.toHaveBeenCalled();
  });

  it("POST /api/watches/[id]/check", async () => {
    const res = await checkPOST(json("http://t/api/watches/w1/check", "POST"), params("w1"));
    expect(res.status).toBe(404);
    expect(watchedSearchMocks.enqueueWatchCheck).not.toHaveBeenCalled();
  });
});

describe("flag-gating — run-due needs BOTH flags", () => {
  const withCron = { "x-cron-secret": CRON_SECRET };

  it("404 when the scheduler flag is off (feature flag on)", async () => {
    process.env.FEATURES_PROFILE_WATCH_SCHEDULER_ENABLED = "false";
    const res = await runDuePOST(json("http://t/api/watches/run-due", "POST", undefined, withCron));
    expect(res.status).toBe(404);
    expect(dbMocks.prisma.searchRun.count).not.toHaveBeenCalled();
  });

  it("404 when the feature flag is off (scheduler flag on)", async () => {
    process.env.FEATURES_PROFILE_WATCH_ENABLED = "false";
    const res = await runDuePOST(json("http://t/api/watches/run-due", "POST", undefined, withCron));
    expect(res.status).toBe(404);
    expect(dbMocks.prisma.searchRun.count).not.toHaveBeenCalled();
  });
});

// ── org-isolation ────────────────────────────────────────────────────────────

describe("org-isolation — routes scope to the caller's org", () => {
  it("GET lists only the caller's org's watches", async () => {
    watchedSearchMocks.listWatches.mockResolvedValueOnce([]);
    await listGET();
    expect(watchedSearchMocks.listWatches).toHaveBeenCalledWith("org-A");
  });

  it("POST creates the watch under the caller's org", async () => {
    watchedSearchMocks.createWatch.mockResolvedValueOnce({ id: "w1", orgId: "org-A" });
    const res = await createPOST(
      json("http://t/api/watches", "POST", { name: "React devs", query: "react" }),
    );
    expect(res.status).toBe(201);
    expect(watchedSearchMocks.createWatch).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-A", createdBy: "u1", name: "React devs", query: "react" }),
    );
  });

  it("PATCH passes the caller's org so another org's id 404s", async () => {
    // org-B caller; updateWatch(id, "org-B", …) misses (returns null) → 404.
    sessionMocks.getAuth.mockResolvedValueOnce(OTHER_ORG);
    watchedSearchMocks.updateWatch.mockResolvedValueOnce(null);
    const res = await watchPATCH(
      json("http://t/api/watches/w-orgA", "PATCH", { name: "z" }),
      params("w-orgA"),
    );
    expect(res.status).toBe(404);
    expect(watchedSearchMocks.updateWatch).toHaveBeenCalledWith("w-orgA", "org-B", expect.any(Object));
  });

  it("DELETE passes the caller's org so another org's id 404s", async () => {
    sessionMocks.getAuth.mockResolvedValueOnce(OTHER_ORG);
    watchedSearchMocks.deleteWatch.mockResolvedValueOnce(false);
    const res = await watchDELETE(json("http://t/api/watches/w-orgA", "DELETE"), params("w-orgA"));
    expect(res.status).toBe(404);
    expect(watchedSearchMocks.deleteWatch).toHaveBeenCalledWith("w-orgA", "org-B");
  });

  it("check loads the watch by (id, caller-org); a foreign id 404s without enqueuing", async () => {
    sessionMocks.getAuth.mockResolvedValueOnce(OTHER_ORG);
    watchedSearchMocks.getWatch.mockResolvedValueOnce(null);
    const res = await checkPOST(json("http://t/api/watches/w-orgA/check", "POST"), params("w-orgA"));
    expect(res.status).toBe(404);
    expect(watchedSearchMocks.getWatch).toHaveBeenCalledWith("w-orgA", "org-B");
    expect(watchedSearchMocks.enqueueWatchCheck).not.toHaveBeenCalled();
  });

  it("check enqueues for an in-org watch and returns the runId (202)", async () => {
    watchedSearchMocks.getWatch.mockResolvedValueOnce({
      id: "w1", orgId: "org-A", jobId: null, query: "react", location: null, intervalMinutes: 1440,
    });
    watchedSearchMocks.enqueueWatchCheck.mockResolvedValueOnce({ runId: "run-1", jobId: "job-1" });
    const res = await checkPOST(json("http://t/api/watches/w1/check", "POST"), params("w1"));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { runId: string; jobId: string };
    expect(body.runId).toBe("run-1");
    expect(watchedSearchMocks.enqueueWatchCheck).toHaveBeenCalledWith(
      expect.objectContaining({ id: "w1", orgId: "org-A" }),
    );
  });
});

// ── interval clamp (I9) ────────────────────────────────────────────────────

describe("interval clamp — sub-floor intervalMinutes is rejected 422", () => {
  it("POST rejects intervalMinutes below the 30-min floor", async () => {
    const res = await createPOST(
      json("http://t/api/watches", "POST", { name: "x", query: "react", intervalMinutes: 5 }),
    );
    expect(res.status).toBe(422);
    expect(watchedSearchMocks.createWatch).not.toHaveBeenCalled();
  });

  it("POST rejects intervalMinutes above the 1440-min ceiling", async () => {
    const res = await createPOST(
      json("http://t/api/watches", "POST", { name: "x", query: "react", intervalMinutes: 5000 }),
    );
    expect(res.status).toBe(422);
    expect(watchedSearchMocks.createWatch).not.toHaveBeenCalled();
  });

  it("POST accepts the floor value (30)", async () => {
    watchedSearchMocks.createWatch.mockResolvedValueOnce({ id: "w1", orgId: "org-A" });
    const res = await createPOST(
      json("http://t/api/watches", "POST", { name: "x", query: "react", intervalMinutes: 30 }),
    );
    expect(res.status).toBe(201);
  });

  it("PATCH rejects sub-floor intervalMinutes", async () => {
    const res = await watchPATCH(
      json("http://t/api/watches/w1", "PATCH", { intervalMinutes: 1 }),
      params("w1"),
    );
    expect(res.status).toBe(422);
    expect(watchedSearchMocks.updateWatch).not.toHaveBeenCalled();
  });
});

// ── run-due auth + cap ──────────────────────────────────────────────────────

describe("run-due — cron-secret auth", () => {
  it("401 when no x-cron-secret header", async () => {
    const res = await runDuePOST(json("http://t/api/watches/run-due", "POST"));
    expect(res.status).toBe(401);
    expect(dbMocks.prisma.searchRun.count).not.toHaveBeenCalled();
  });

  it("401 when the cron secret is wrong", async () => {
    const res = await runDuePOST(
      json("http://t/api/watches/run-due", "POST", undefined, { "x-cron-secret": "nope" }),
    );
    expect(res.status).toBe(401);
    expect(dbMocks.prisma.searchRun.count).not.toHaveBeenCalled();
  });

  it("401 when CONTACT_SYNC_CRON_SECRET is unset (no secret can match)", async () => {
    delete process.env.CONTACT_SYNC_CRON_SECRET;
    const res = await runDuePOST(
      json("http://t/api/watches/run-due", "POST", undefined, { "x-cron-secret": CRON_SECRET }),
    );
    expect(res.status).toBe(401);
  });
});

describe("run-due — daily cap", () => {
  const withCron = { "x-cron-secret": CRON_SECRET };

  it("enqueues every due watch when under cap", async () => {
    dbMocks.prisma.searchRun.count.mockResolvedValueOnce(0); // none run today
    dbMocks.prisma.watchedSearch.findMany.mockResolvedValueOnce([
      { id: "w1", orgId: "org-A", jobId: null, query: "react", location: null, intervalMinutes: 1440 },
      { id: "w2", orgId: "org-A", jobId: null, query: "go", location: null, intervalMinutes: 1440 },
    ]);
    watchedSearchMocks.enqueueWatchCheck
      .mockResolvedValueOnce({ runId: "r1", jobId: "j1" })
      .mockResolvedValueOnce({ runId: "r2", jobId: "j2" });

    const res = await runDuePOST(json("http://t/api/watches/run-due", "POST", undefined, withCron));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, number>;
    expect(body.due).toBe(2);
    expect(body.enqueued).toBe(2);
    expect(body.skippedForCap).toBe(0);
    expect(watchedSearchMocks.enqueueWatchCheck).toHaveBeenCalledTimes(2);
  });

  it("skips due watches once the cap is exhausted, enqueuing only the remainder", async () => {
    process.env.WATCH_DAILY_CAP = "3";
    dbMocks.prisma.searchRun.count.mockResolvedValueOnce(2); // 2 already today → 1 left
    dbMocks.prisma.watchedSearch.findMany.mockResolvedValueOnce([
      { id: "w1", orgId: "org-A", jobId: null, query: "a", location: null, intervalMinutes: 1440 },
      { id: "w2", orgId: "org-A", jobId: null, query: "b", location: null, intervalMinutes: 1440 },
      { id: "w3", orgId: "org-A", jobId: null, query: "c", location: null, intervalMinutes: 1440 },
    ]);
    watchedSearchMocks.enqueueWatchCheck.mockResolvedValueOnce({ runId: "r1", jobId: null });

    const res = await runDuePOST(json("http://t/api/watches/run-due", "POST", undefined, withCron));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, number>;
    expect(body.cap).toBe(3);
    expect(body.ranToday).toBe(2);
    expect(body.remaining).toBe(1);
    expect(body.due).toBe(3);
    expect(body.enqueued).toBe(1);
    expect(body.skippedForCap).toBe(2);
    // Only ONE watch enqueued despite three being due.
    expect(watchedSearchMocks.enqueueWatchCheck).toHaveBeenCalledTimes(1);
  });

  it("enqueues nothing and never queries due watches once the cap is fully spent", async () => {
    process.env.WATCH_DAILY_CAP = "5";
    dbMocks.prisma.searchRun.count.mockResolvedValueOnce(5); // cap reached
    const res = await runDuePOST(json("http://t/api/watches/run-due", "POST", undefined, withCron));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, number>;
    expect(body.remaining).toBe(0);
    expect(body.enqueued).toBe(0);
    expect(dbMocks.prisma.watchedSearch.findMany).not.toHaveBeenCalled();
    expect(watchedSearchMocks.enqueueWatchCheck).not.toHaveBeenCalled();
  });

  it("counts only today's watch-tagged runs (requestedBy startsWith 'watch:')", async () => {
    dbMocks.prisma.searchRun.count.mockResolvedValueOnce(0);
    dbMocks.prisma.watchedSearch.findMany.mockResolvedValueOnce([]);
    await runDuePOST(json("http://t/api/watches/run-due", "POST", undefined, withCron));
    const arg = dbMocks.prisma.searchRun.count.mock.calls[0][0] as {
      where: { requestedBy: { startsWith: string }; createdAt: { gte: Date } };
    };
    expect(arg.where.requestedBy).toEqual({ startsWith: "watch:" });
    expect(arg.where.createdAt.gte).toBeInstanceOf(Date);
  });

  it("only selects active + due watches (active true, nextRunAfter <= now)", async () => {
    dbMocks.prisma.searchRun.count.mockResolvedValueOnce(0);
    dbMocks.prisma.watchedSearch.findMany.mockResolvedValueOnce([]);
    await runDuePOST(json("http://t/api/watches/run-due", "POST", undefined, withCron));
    const arg = dbMocks.prisma.watchedSearch.findMany.mock.calls[0][0] as {
      where: { active: boolean; nextRunAfter: { lte: Date } };
    };
    expect(arg.where.active).toBe(true);
    expect(arg.where.nextRunAfter.lte).toBeInstanceOf(Date);
  });
});
