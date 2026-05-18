import { describe, expect, it } from "vitest";
import { planSync } from "../sync";
import type { SheetRow } from "../types";

const job1 = { id: "job1", title: "Technical Support & Sales Engineer – Power & SCADA", orgId: "org1" };
const job2 = { id: "job2", title: "Tech Manager", orgId: "org1" };

const cand = (over: Partial<{ id: string; jobId: string; linkedinUrl: string; status: string; notes: string | null }>) => ({
  id: "c1",
  jobId: "job1",
  linkedinUrl: "https://www.linkedin.com/in/rohit-prasad-7a440040",
  status: "new",
  notes: null,
  ...over,
});

const row = (over: Partial<SheetRow>): SheetRow => ({
  rowNumber: 2,
  linkedinUrl: "https://www.linkedin.com/in/rohit-prasad-7a440040/",
  status: "JD sent",
  candidateName: "Rohit Prasad",
  company: "Helios Power",
  notes: null,
  owner: "Baeley",
  lastContacted: null,
  ...over,
});

describe("planSync", () => {
  it("matches tab to job + creates ContactEvent on 'JD sent' WITHOUT changing Candidate.status", () => {
    // Existing UX: contacts surface via the blue-dot ContactEvent indicator
    // on the candidate card. The sync should NEVER flip Candidate.status
    // to "contacted" — that would clobber the recruiter's pipeline state
    // AND hide the per-event userName attribution shown by the dot.
    const candidatesByKey = new Map([[`job1::https://www.linkedin.com/in/rohit-prasad-7a440040`, cand({})]]);
    const { plans, unmatchedTabs } = planSync({
      tabs: new Map([["Technical Support & Sales Engineer ADR", [row({})]]]),
      activeJobs: [job1, job2],
      candidatesByKey,
      contactEventDayKeys: new Set(),
    });
    expect(unmatchedTabs).toEqual([]);
    expect(plans).toHaveLength(1);
    expect(plans[0].action).toBe("update");
    if (plans[0].action === "update") {
      expect(plans[0].newStatus).toBeUndefined();
      expect(plans[0].addContactEvent).toBe(true);
      expect(plans[0].jobId).toBe("job1");
    }
  });

  it("ContactEvent is added even when candidate is already at a protected pipeline state", () => {
    // 'shortlisted' is protected for STATUS overwrites — but we still
    // want to record the touch so the blue-dot tooltip shows it.
    const candidatesByKey = new Map([
      [`job1::https://www.linkedin.com/in/rohit-prasad-7a440040`, cand({ status: "shortlisted" })],
    ]);
    const { plans } = planSync({
      tabs: new Map([["Technical Support & Sales Engineer ADR", [row({})]]]),
      activeJobs: [job1],
      candidatesByKey,
      contactEventDayKeys: new Set(),
    });
    expect(plans[0].action).toBe("update");
    if (plans[0].action === "update") {
      expect(plans[0].newStatus).toBeUndefined();
      expect(plans[0].addContactEvent).toBe(true);
    }
  });

  it("flips contacted→declined when sheet says 'Not interested'", () => {
    const candidatesByKey = new Map([
      [`job1::https://www.linkedin.com/in/rohit-prasad-7a440040`, cand({ status: "contacted" })],
    ]);
    const { plans } = planSync({
      tabs: new Map([["Technical Support & Sales Engineer ADR", [row({ status: "Not interested/not looking" })]]]),
      activeJobs: [job1],
      candidatesByKey,
      contactEventDayKeys: new Set(),
    });
    expect(plans[0].action).toBe("update");
    if (plans[0].action === "update") {
      expect(plans[0].newStatus).toBe("declined");
      // 'Not interested' is NOT a touch event.
      expect(plans[0].addContactEvent).toBe(false);
    }
  });

  it("skips rows whose tab doesn't fuzzy-match any active job", () => {
    const { plans, unmatchedTabs } = planSync({
      tabs: new Map([["Marketing Coordinator", [row({})]]]),
      activeJobs: [job1, job2],
      candidatesByKey: new Map(),
      contactEventDayKeys: new Set(),
    });
    expect(unmatchedTabs).toEqual(["Marketing Coordinator"]);
    expect(plans[0]).toMatchObject({ action: "skip", reason: "no_job_match" });
  });

  it("skips rows whose LinkedIn URL doesn't match any candidate in the matched job", () => {
    const { plans } = planSync({
      tabs: new Map([["Technical Support & Sales Engineer ADR", [row({ linkedinUrl: "https://www.linkedin.com/in/stranger/" })]]]),
      activeJobs: [job1],
      candidatesByKey: new Map(),
      contactEventDayKeys: new Set(),
    });
    expect(plans[0]).toMatchObject({ action: "skip", reason: "candidate_not_found" });
  });

  it("skips rows with empty Status", () => {
    const candidatesByKey = new Map([[`job1::https://www.linkedin.com/in/rohit-prasad-7a440040`, cand({})]]);
    const { plans } = planSync({
      tabs: new Map([["Technical Support & Sales Engineer ADR", [row({ status: "" })]]]),
      activeJobs: [job1],
      candidatesByKey,
      contactEventDayKeys: new Set(),
    });
    expect(plans[0]).toMatchObject({ action: "skip", reason: "empty_status" });
  });

  it("skips rows whose Status doesn't map to any known action", () => {
    const candidatesByKey = new Map([[`job1::https://www.linkedin.com/in/rohit-prasad-7a440040`, cand({})]]);
    const { plans } = planSync({
      tabs: new Map([["Technical Support & Sales Engineer ADR", [row({ status: "Pending approval from HR" })]]]),
      activeJobs: [job1],
      candidatesByKey,
      contactEventDayKeys: new Set(),
    });
    expect(plans[0]).toMatchObject({ action: "skip", reason: "unknown_status" });
  });

  it("does not duplicate a ContactEvent for the same day (idempotency)", () => {
    const candidatesByKey = new Map([[`job1::https://www.linkedin.com/in/rohit-prasad-7a440040`, cand({ status: "contacted" })]]);
    // Existing event recorded today.
    const today = new Date();
    const dayKey = `c1::${today.toISOString().slice(0, 10)}`;
    const { plans } = planSync({
      tabs: new Map([["Technical Support & Sales Engineer ADR", [row({ lastContacted: today })]]]),
      activeJobs: [job1],
      candidatesByKey,
      contactEventDayKeys: new Set([dayKey]),
    });
    expect(plans[0]).toMatchObject({ action: "skip", reason: "no_change_needed" });
  });

  it("skips the 'Template' tab by default", () => {
    const { plans, unmatchedTabs } = planSync({
      tabs: new Map([["Template", [row({})]]]),
      activeJobs: [job1],
      candidatesByKey: new Map(),
      contactEventDayKeys: new Set(),
    });
    expect(plans).toEqual([]);
    expect(unmatchedTabs).toEqual([]);
  });

  it("appends new note to candidate.notes when content is present and not already there", () => {
    const candidatesByKey = new Map([
      [`job1::https://www.linkedin.com/in/rohit-prasad-7a440040`, cand({ notes: "existing notes" })],
    ]);
    const { plans } = planSync({
      tabs: new Map([
        ["Technical Support & Sales Engineer ADR", [row({ notes: "Interested but not further replies." })]],
      ]),
      activeJobs: [job1],
      candidatesByKey,
      contactEventDayKeys: new Set(),
    });
    if (plans[0].action === "update") {
      expect(plans[0].noteToAppend).toBe("Interested but not further replies.");
    } else {
      throw new Error("expected update");
    }
  });

  it("does NOT re-append a note that's already in candidate.notes", () => {
    const candidatesByKey = new Map([
      [
        `job1::https://www.linkedin.com/in/rohit-prasad-7a440040`,
        cand({ status: "contacted", notes: "Interested but not further replies." }),
      ],
    ]);
    const { plans } = planSync({
      tabs: new Map([
        ["Technical Support & Sales Engineer ADR", [
          row({ status: "JD sent", notes: "Interested but not further replies." }),
        ]],
      ]),
      activeJobs: [job1],
      candidatesByKey,
      // Treat the event as already present so we test pure note-dedupe.
      contactEventDayKeys: new Set([`c1::${new Date().toISOString().slice(0, 10)}`]),
    });
    expect(plans[0]).toMatchObject({ action: "skip", reason: "no_change_needed" });
  });
});
