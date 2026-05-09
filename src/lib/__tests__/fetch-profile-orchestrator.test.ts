import { describe, it, expect, vi } from "vitest";
import {
  orchestrateFetchProfile,
  cleanupAbortedAfterSuccess,
  type BlankTab,
} from "../fetch-profile-orchestrator";

function makeTab(): BlankTab & { url: string | null; closed: boolean } {
  const tab = {
    url: null as string | null,
    closed: false,
    setUrl(url: string) { tab.url = url; },
    close() { tab.closed = true; },
  };
  return tab;
}

describe("orchestrateFetchProfile", () => {
  it("opens the blank tab BEFORE the session POST, navigates only after success", async () => {
    const tab = makeTab();
    const events: string[] = [];

    const result = await orchestrateFetchProfile({
      linkedinUrl: "https://www.linkedin.com/in/alex/",
      openBlankTab: () => { events.push("openBlankTab"); return tab; },
      postFetchSession: async () => {
        events.push("postFetchSession");
        // The tab MUST still be on about:blank at this point — that's the whole
        // point of the fix. If setUrl already ran we'd have the race back.
        expect(tab.url).toBeNull();
        return { ok: true, session: { sessionId: "sess-1", message: "Waiting" } };
      },
    });

    expect(result).toEqual({ kind: "success", sessionId: "sess-1", message: "Waiting" });
    expect(events).toEqual(["openBlankTab", "postFetchSession"]);
    // Navigation happens AFTER the session POST returns success.
    expect(tab.url).toBe("https://www.linkedin.com/in/alex/");
    expect(tab.closed).toBe(false);
  });

  it("does not navigate to LinkedIn when the session POST fails — closes the blank tab", async () => {
    const tab = makeTab();
    const result = await orchestrateFetchProfile({
      linkedinUrl: "https://www.linkedin.com/in/alex/",
      openBlankTab: () => tab,
      postFetchSession: async () => ({ ok: false, error: "Could not start capture" }),
    });

    expect(result).toEqual({ kind: "session_failed", message: "Could not start capture" });
    expect(tab.url).toBeNull();          // never navigated
    expect(tab.closed).toBe(true);        // blank tab cleaned up
  });

  it("does not navigate when the session POST throws — closes the tab and surfaces the error", async () => {
    const tab = makeTab();
    const result = await orchestrateFetchProfile({
      linkedinUrl: "https://www.linkedin.com/in/alex/",
      openBlankTab: () => tab,
      postFetchSession: async () => { throw new Error("offline"); },
    });

    expect(result).toEqual({ kind: "session_failed", message: "offline" });
    expect(tab.url).toBeNull();
    expect(tab.closed).toBe(true);
  });

  it("returns popup_blocked when the browser refuses to open the tab", async () => {
    const postFetchSession = vi.fn();
    const result = await orchestrateFetchProfile({
      linkedinUrl: "https://www.linkedin.com/in/alex/",
      openBlankTab: () => null,
      postFetchSession,
    });

    expect(result).toEqual({ kind: "popup_blocked" });
    // We must NOT have hit the server when the popup was blocked — otherwise
    // we'd leak a session the user can't act on.
    expect(postFetchSession).not.toHaveBeenCalled();
  });

  it("the BlankTab adapter shape — setUrl is called once and only after success", async () => {
    // The orchestrator can't reach into the page's adapter, but it CAN prove
    // the adapter's setUrl is invoked exactly once and only on success — any
    // adapter that clears window.opener inside setUrl (as the page does) will
    // therefore have done so before the navigation. This is the testable
    // contract that lets us be confident opener is severed.
    const setUrl = vi.fn();
    const close = vi.fn();
    const tab: BlankTab = { setUrl, close };

    const result = await orchestrateFetchProfile({
      linkedinUrl: "https://www.linkedin.com/in/alex/",
      openBlankTab: () => tab,
      postFetchSession: async () => {
        // Adapter must NOT have been invoked before the POST resolves.
        expect(setUrl).not.toHaveBeenCalled();
        return { ok: true, session: { sessionId: "sess-1" } };
      },
    });
    expect(result.kind).toBe("success");
    expect(setUrl).toHaveBeenCalledTimes(1);
    expect(setUrl).toHaveBeenCalledWith("https://www.linkedin.com/in/alex/");
    expect(close).not.toHaveBeenCalled();
  });

  it("returns aborted (not success) when isAborted flips true between POST and navigate", async () => {
    const tab = makeTab();
    let aborted = false;
    const result = await orchestrateFetchProfile({
      linkedinUrl: "https://www.linkedin.com/in/alex/",
      openBlankTab: () => tab,
      postFetchSession: async () => {
        // Recruiter clicks Cancel while POST is in flight.
        aborted = true;
        return { ok: true, session: { sessionId: "sess-aborted" } };
      },
      isAborted: () => aborted,
    });

    expect(result).toEqual({ kind: "aborted", sessionId: "sess-aborted" });
    expect(tab.url).toBeNull();   // never navigated to LinkedIn
    expect(tab.closed).toBe(true); // tab closed
  });

  it("succeeds even if the user closed the blank tab before navigation lands", async () => {
    const tab = makeTab();
    tab.setUrl = () => { throw new Error("tab is null"); };

    const result = await orchestrateFetchProfile({
      linkedinUrl: "https://www.linkedin.com/in/alex/",
      openBlankTab: () => tab,
      postFetchSession: async () => ({ ok: true, session: { sessionId: "sess-2" } }),
    });

    // Session was created — recruiter can navigate manually. We don't pretend
    // the navigation succeeded, but we also don't roll back a valid session.
    expect(result).toEqual({
      kind: "success", sessionId: "sess-2",
      message: "Waiting for browser extension to capture",
    });
  });
});

describe("cleanupAbortedAfterSuccess", () => {
  it("DELETEs the orphan session, removes the active map entry, and clears the UI", () => {
    const events: string[] = [];
    cleanupAbortedAfterSuccess({
      sessionId: "sess-orphan",
      deleteServerSession: (sid) => events.push(`DELETE ${sid}`),
      removeFromActiveMap: () => events.push("removeFromActiveMap"),
      clearUiStatus: () => events.push("clearUiStatus"),
    });
    // Order matters less than completeness — but every step must fire.
    expect(events).toContain("DELETE sess-orphan");
    expect(events).toContain("removeFromActiveMap");
    expect(events).toContain("clearUiStatus");
  });

  it("skips the server DELETE when no sessionId was returned", () => {
    const events: string[] = [];
    cleanupAbortedAfterSuccess({
      sessionId: null,
      deleteServerSession: (sid) => events.push(`DELETE ${sid}`),
      removeFromActiveMap: () => events.push("removeFromActiveMap"),
      clearUiStatus: () => events.push("clearUiStatus"),
    });
    expect(events).not.toContain("DELETE null");
    expect(events.some((e) => e.startsWith("DELETE"))).toBe(false);
    // Still clears the UI / removes the active entry — those are local state
    // and never depend on a server round-trip.
    expect(events).toContain("removeFromActiveMap");
    expect(events).toContain("clearUiStatus");
  });
});
