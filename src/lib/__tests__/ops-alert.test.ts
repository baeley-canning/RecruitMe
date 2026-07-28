import { describe, it, expect } from "vitest";
import {
  decideAlert,
  unhealthyChecks,
  EMPTY_ALERT_STATE,
  DEFAULT_ALERT_GRACE_MS,
  type HealthLike,
  type AlertState,
} from "@/lib/ops-alert";

const T0 = new Date("2026-07-28T00:00:00Z").getTime();
const MIN = 60_000;

function health(over: Partial<Record<string, unknown>> = {}, checks: Record<string, unknown> = {}): HealthLike {
  return {
    ok: true,
    degraded: false,
    checks: {
      db: { ok: true },
      scraper: { ok: true },
      pulse: { ok: true },
      ai: { ok: true },
      ollama: { ok: true, skipped: true },
      ...checks,
    },
    ...over,
  } as HealthLike;
}

describe("unhealthyChecks", () => {
  it("counts failing AND degraded checks, ignores skipped dependencies", () => {
    const h = health({}, {
      pulse: { ok: false, degraded: true, detail: "6/6 watches failing" },
      scraper: { ok: true, degraded: true, detail: "heartbeat STALE" },
      ollama: { ok: false, skipped: true }, // not used by this deployment
    });
    expect(unhealthyChecks(h)).toEqual(["pulse", "scraper"]);
  });

  it("is empty when everything is fine", () => {
    expect(unhealthyChecks(health())).toEqual([]);
  });
});

describe("decideAlert — the state machine", () => {
  it("stays silent during the grace period (a deploy blip must not page anyone)", () => {
    const bad = health({ degraded: true }, { pulse: { ok: false, degraded: true } });
    const d1 = decideAlert(EMPTY_ALERT_STATE, bad, T0);
    expect(d1.action).toBe("none");
    // 14 minutes in — still inside the 15-minute grace
    const d2 = decideAlert(d1.state, bad, T0 + 14 * MIN);
    expect(d2.action).toBe("none");
  });

  it("REGRESSION (9-days-silent): a persistent DEGRADED subsystem fires once the grace passes", () => {
    const bad = health({ ok: true, degraded: true }, {
      pulse: { ok: false, degraded: true, detail: "6/6 Pulse watches failing — SEEK session needs re-login on the box" },
    });
    let s: AlertState = EMPTY_ALERT_STATE;
    s = decideAlert(s, bad, T0).state;
    const fired = decideAlert(s, bad, T0 + DEFAULT_ALERT_GRACE_MS);
    expect(fired.action).toBe("fire");
    expect(fired.message).toContain("degraded");
    expect(fired.message).toContain("pulse");
    expect(fired.message).toContain("re-login on the box"); // actionable detail carried through
  });

  it("does NOT spam: an ongoing, unchanged outage alerts exactly once", () => {
    const bad = health({ degraded: true }, { pulse: { ok: false, degraded: true } });
    let s = decideAlert(EMPTY_ALERT_STATE, bad, T0).state;
    const first = decideAlert(s, bad, T0 + 20 * MIN);
    expect(first.action).toBe("fire");
    s = first.state;
    for (const t of [30, 60, 240, 1440]) {
      const again = decideAlert(s, bad, T0 + t * MIN);
      expect(again.action).toBe("none");
      s = again.state;
    }
  });

  it("re-alerts when the situation CHANGES (degraded → also down is new information)", () => {
    const degraded = health({ degraded: true }, { pulse: { ok: false, degraded: true } });
    let s = decideAlert(EMPTY_ALERT_STATE, degraded, T0).state;
    s = decideAlert(s, degraded, T0 + 20 * MIN).state; // fired

    const worse = health({ ok: false }, { pulse: { ok: false, degraded: true }, db: { ok: false, detail: "db ping failed" } });
    // New signature restarts the clock…
    const t1 = decideAlert(s, worse, T0 + 21 * MIN);
    expect(t1.action).toBe("none");
    // …then fires on its own merit.
    const t2 = decideAlert(t1.state, worse, T0 + 21 * MIN + DEFAULT_ALERT_GRACE_MS);
    expect(t2.action).toBe("fire");
    expect(t2.message).toContain("DOWN");
    expect(t2.message).toContain("db");
  });

  it("sends a recovery notice — but only if a problem was actually announced", () => {
    const bad = health({ degraded: true }, { pulse: { ok: false, degraded: true } });
    let s = decideAlert(EMPTY_ALERT_STATE, bad, T0).state;
    s = decideAlert(s, bad, T0 + 20 * MIN).state; // fired

    const rec = decideAlert(s, health(), T0 + 30 * MIN);
    expect(rec.action).toBe("recover");
    expect(rec.message).toContain("recovered");
    expect(rec.state).toEqual(EMPTY_ALERT_STATE);

    // A blip that resolved inside the grace period never alerted → stays silent.
    const quiet = decideAlert(decideAlert(EMPTY_ALERT_STATE, bad, T0).state, health(), T0 + 5 * MIN);
    expect(quiet.action).toBe("none");
  });

  it("a fully healthy system is silent from a cold start", () => {
    const d = decideAlert(EMPTY_ALERT_STATE, health(), T0);
    expect(d.action).toBe("none");
    expect(d.state).toEqual(EMPTY_ALERT_STATE);
  });

  it("honours a custom grace period", () => {
    const bad = health({ degraded: true }, { scraper: { ok: false } });
    const s = decideAlert(EMPTY_ALERT_STATE, bad, T0, 5 * MIN).state;
    expect(decideAlert(s, bad, T0 + 4 * MIN, 5 * MIN).action).toBe("none");
    expect(decideAlert(s, bad, T0 + 5 * MIN, 5 * MIN).action).toBe("fire");
  });
});
