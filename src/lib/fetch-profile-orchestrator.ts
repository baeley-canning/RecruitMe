/**
 * Sequence the LinkedIn-tab open and fetch-session POST so the extension
 * never sees a LinkedIn tab without a matching pending session.
 *
 * The race we're closing: window.open + immediate navigation to the LinkedIn
 * URL means the extension's content script can fire its
 * /api/extension/fetch-session/pending check before the app's POST finishes.
 * In manual-only mode the extension then bails and the capture sits idle.
 *
 * The fix: open the tab to about:blank inside the user gesture (so popup
 * blockers don't fire), POST the session, and ONLY THEN navigate the
 * already-open tab to LinkedIn. If session creation fails, close the blank
 * tab so the user isn't left with a stray window.
 *
 * Pure orchestration — IO is dependency-injected so a unit test can drive
 * the sequence without a browser or a server.
 */

export interface BlankTab {
  /** Navigate the (already-open) tab to a real URL. Best-effort. */
  setUrl(url: string): void;
  /** Close the tab. Best-effort — same-origin tabs (about:blank) only. */
  close(): void;
}

export type FetchSessionResponse = {
  sessionId: string;
  message?: string | null;
  status?: string | null;
};

export type FetchProfileOutcome =
  | { kind: "popup_blocked" }
  | { kind: "session_failed"; message: string }
  | { kind: "success"; sessionId: string; message: string }
  // Caller cancelled mid-flight. If a session was created server-side before
  // the cancel landed, sessionId is set so the caller can DELETE it.
  | { kind: "aborted"; sessionId: string | null };

export interface OrchestrateFetchProfileDeps {
  linkedinUrl: string;
  /** Open a blank tab synchronously inside the user gesture. May return null
   *  if the browser blocked the popup. */
  openBlankTab(): BlankTab | null;
  /** POST the fetch-session and return either a session payload or an error
   *  message that can be surfaced to the recruiter. */
  postFetchSession(): Promise<
    | { ok: true; session: FetchSessionResponse }
    | { ok: false; error: string }
  >;
  /** Optional. Polled at the two interrupt points (after open, after POST).
   *  When it returns true, we skip the LinkedIn navigation and close the
   *  tab — caller (e.g. handleCancelFetch) can flip the underlying flag. */
  isAborted?(): boolean;
}

export async function orchestrateFetchProfile(
  deps: OrchestrateFetchProfileDeps,
): Promise<FetchProfileOutcome> {
  const isAborted = () => deps.isAborted?.() ?? false;

  // Step 1: open the tab to about:blank during the user gesture. If we open
  // the real LinkedIn URL here, the extension's pending check can fire before
  // the session exists and the capture will be lost in manual-only mode.
  const tab = deps.openBlankTab();
  if (!tab) {
    return { kind: "popup_blocked" };
  }

  // Step 2: create the session BEFORE the tab navigates anywhere LinkedIn-shaped.
  let result: Awaited<ReturnType<OrchestrateFetchProfileDeps["postFetchSession"]>>;
  try {
    result = await deps.postFetchSession();
  } catch (err) {
    safeCloseTab(tab);
    return {
      kind: "session_failed",
      message: err instanceof Error ? err.message : "Network error starting capture",
    };
  }

  if (!result.ok) {
    safeCloseTab(tab);
    return { kind: "session_failed", message: result.error };
  }

  // Step 3: cancel-during-POST guard. If the recruiter cancelled while we
  // were awaiting the server, do NOT navigate (would orphan a tab) and do
  // NOT pretend success (would leak a polling interval). Return the
  // sessionId so the caller can DELETE it server-side.
  if (isAborted()) {
    safeCloseTab(tab);
    return { kind: "aborted", sessionId: result.session.sessionId };
  }

  // Step 4: the session exists and we weren't cancelled — navigate. From
  // this point the extension's /pending check will find the session.
  try {
    tab.setUrl(deps.linkedinUrl);
  } catch {
    // Tab may have been closed by the user mid-flight. The session is still
    // valid — surface success so the recruiter can navigate manually.
  }

  return {
    kind: "success",
    sessionId: result.session.sessionId,
    message: result.session.message ?? "Waiting for browser extension to capture",
  };
}

function safeCloseTab(tab: BlankTab) {
  try { tab.close(); } catch { /* best-effort */ }
}
