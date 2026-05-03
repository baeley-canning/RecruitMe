const DEFAULT_SERVER_BASES = [
  "https://recruitme-production-8cc6.up.railway.app",
  "https://recruitme.railway.app",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://10.255.255.254:3000",
];

const PENDING_CAPTURE_ALARM = "recruitme-pending-capture-check";
const activeAutoCaptures = new Map(); // sessionId -> startedAt timestamp
const pendingSessionEnsures = new Set();
const autoOpenedTabs = new Set(); // Tab IDs auto-opened by the extension for background capture
const ERROR_BADGE_COLOR = "#b91c1c";

async function setExtensionError(message) {
  const error = message || "RecruitMe extension error";
  await chrome.storage.local.set({ lastError: error });
  await chrome.action.setBadgeText({ text: "!" });
  await chrome.action.setBadgeBackgroundColor({ color: ERROR_BADGE_COLOR });
  await chrome.action.setTitle({ title: `RecruitMe LinkedIn Capture\n${error}` });
}

async function clearExtensionError() {
  await chrome.storage.local.set({ lastError: "" });
  await chrome.action.setBadgeText({ text: "" });
  await chrome.action.setTitle({ title: "RecruitMe LinkedIn Capture" });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normaliseServerBase(base = "") {
  const trimmed = base.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

async function getStoredSettings() {
  return chrome.storage.local.get({
    serverBase: "",
    lastWorkingServerBase: "",
    lastError: "",
  });
}

async function getServerBases() {
  const settings = await getStoredSettings();
  const bases = [
    normaliseServerBase(settings.serverBase || ""),
    normaliseServerBase(settings.lastWorkingServerBase || ""),
    ...DEFAULT_SERVER_BASES,
  ].filter(Boolean);
  return [...new Set(bases)];
}

function withTimeout(url, options = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Request timed out")), timeoutMs);
    fetch(url, options)
      .then((response) => {
        clearTimeout(timer);
        resolve(response);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

async function requestRecruitMe(path, options = {}, preferredBase = "", overrides = {}) {
  const allowFallback = overrides.allowFallback !== false;
  let bases;
  if (preferredBase && !allowFallback) {
    bases = [preferredBase];
  } else if (preferredBase) {
    bases = [preferredBase, ...(await getServerBases()).filter((base) => base !== preferredBase)];
  } else {
    bases = await getServerBases();
  }
  const rememberFailure = overrides.rememberFailure !== false;
  const acceptData = typeof overrides.acceptData === "function" ? overrides.acceptData : null;
  const timeoutMs =
    typeof overrides.timeoutMs === "number"
      ? overrides.timeoutMs
      : typeof options.timeoutMs === "number"
      ? options.timeoutMs
      : 10000;

  let lastError = new Error("Could not connect to RecruitMe");

  for (const base of bases) {
    try {
      const headers = new Headers(options.headers || {});
      const requestOptions = { ...options };
      delete requestOptions.timeoutMs;

      if (requestOptions.body && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }

      const response = await withTimeout(`${base}${path}`, { ...requestOptions, headers }, timeoutMs);
      const text = await response.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { error: text };
        }
      }

      if (!response.ok) {
        lastError = new Error(data?.error || `RecruitMe request failed (${response.status})`);
        continue;
      }

      if (acceptData && !acceptData(data)) {
        lastError = new Error("RecruitMe server had no matching pending capture");
        continue;
      }

      await chrome.storage.local.set({ lastWorkingServerBase: base });
      await clearExtensionError();
      return { base, data };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (rememberFailure) {
    await setExtensionError(lastError.message);
  }
  throw lastError;
}

function toUserFacingCaptureError(error) {
  const message = error instanceof Error ? error.message : String(error || "");

  if (/Receiving end does not exist|Could not establish connection/i.test(message)) {
    return "RecruitMe could not attach to the LinkedIn tab. Reload the extension and try again.";
  }
  if (/Request timed out/i.test(message)) {
    return "RecruitMe took too long to respond. Check the app is running and the server URL in the popup.";
  }
  if (/LinkedIn URL mismatch/i.test(message)) {
    return "The open LinkedIn profile did not match the queued candidate.";
  }
  if (/not contain enough usable profile text|too short/i.test(message)) {
    return "RecruitMe only captured the profile header. Reload the LinkedIn tab, make sure you are signed in, then try Fetch profile again.";
  }

  return message || "LinkedIn capture failed";
}

async function markPendingCaptureError(pending, error, preferredBase = "") {
  if (!pending?.sessionId) return;

  const message = toUserFacingCaptureError(error).slice(0, 500);
  await setExtensionError(message);

  try {
    await requestRecruitMe(
      "/api/extension/fetch-session/error",
      {
        method: "POST",
        body: JSON.stringify({
          sessionId: pending.sessionId,
          error: message,
        }),
      },
      preferredBase,
      { rememberFailure: false }
    );
  } catch (reportError) {
    console.warn("RecruitMe failed to report capture error:", reportError);
  }
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "LinkedIn capture failed"));
        return;
      }
      resolve(response);
    });
  });
}

async function checkPendingCapture(linkedinUrl) {
  try {
    const { base, data } = await requestRecruitMe(
      `/api/extension/fetch-session/pending?linkedinUrl=${encodeURIComponent(linkedinUrl)}`,
      {},
      "",
      {
        rememberFailure: false,
        acceptData: (data) => Boolean(data?.active || data?.pending),
      }
    );
    return { base, data };
  } catch {
    return { base: "", data: { pending: false, active: false, status: "idle" } };
  }
}

async function getPendingSessions() {
  let base = "";
  let data = null;
  try {
    ({ base, data } = await requestRecruitMe(
      "/api/extension/fetch-session",
      {},
      "",
      {
        rememberFailure: false,
        acceptData: (data) => (Array.isArray(data) ? data.length > 0 : Boolean(data)),
      }
    ));
  } catch {
    data = null;
  }
  const sessions = Array.isArray(data) ? data : data ? [data] : [];
  return {
    base,
    sessions: sessions.filter((session) => session?.status === "pending" && session.linkedinUrl),
  };
}

function isRootLinkedInProfile(url = "") {
  // Must be linkedin.com/in/<username> with no sub-path (e.g. not /details/experience)
  return /linkedin\.com\/in\/[^/?#]+\/?([?#].*)?$/.test(url);
}

function normaliseLinkedInUrl(url = "") {
  if (!url) return "";

  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/in\/([^/?#]+)/i);
    if (!match) return "";
    return `https://www.linkedin.com/in/${match[1].toLowerCase()}`;
  } catch {
    const match = url.match(/linkedin\.com\/in\/([^/?#\s]+)/i);
    return match ? `https://www.linkedin.com/in/${match[1].toLowerCase()}` : "";
  }
}

function linkedInSlugAliasKey(url = "") {
  const match = url.match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  const slug = match ? match[1] : "";
  return slug
    .toLowerCase()
    .replace(/-[a-z0-9]*\d[a-z0-9]{5,}$/i, "")
    .replace(/[^a-z0-9]/g, "");
}

function linkedInProfileMatches(a = "", b = "") {
  if (!a || !b) return false;
  if (normaliseLinkedInUrl(a) === normaliseLinkedInUrl(b)) return true;

  const aKey = linkedInSlugAliasKey(a);
  const bKey = linkedInSlugAliasKey(b);
  return aKey.length >= 6 && aKey === bKey;
}

async function findLinkedInProfileTab(linkedinUrl) {
  const targetUrl = normaliseLinkedInUrl(linkedinUrl);
  if (!targetUrl) return null;

  const tabs = await chrome.tabs.query({ url: ["https://www.linkedin.com/in/*"] });
  const matchingTabs = tabs.filter((tab) => linkedInProfileMatches(tab.url || "", targetUrl));
  return matchingTabs.find((tab) => isRootLinkedInProfile(tab.url || "")) || matchingTabs[0] || null;
}

async function openPendingProfileTab(linkedinUrl) {
  // active: true ensures LinkedIn renders all sections via IntersectionObserver
  // (background tabs have innerHeight=0 so lazy sections never load → "too short")
  const created = await chrome.tabs.create({ url: linkedinUrl, active: true });
  const tabId = created?.id ?? null;
  if (tabId) autoOpenedTabs.add(tabId);
  return tabId;
}

async function waitForTabComplete(tabId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error("LinkedIn tab closed before capture could start");
    if (tab.status === "complete" && tab.url) return tab;
    await sleep(250);
  }
  throw new Error("LinkedIn tab did not finish loading in time");
}

async function prepareTabForCapture(tabId, linkedinUrl) {
  let tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw new Error("LinkedIn tab is no longer available");

  const currentUrl = tab.url || "";
  const needsNavigation =
    !linkedInProfileMatches(currentUrl, linkedinUrl) ||
    !isRootLinkedInProfile(currentUrl);

  if (needsNavigation) {
    tab = await chrome.tabs.update(tabId, { url: linkedinUrl, active: true });
    await waitForTabComplete(tabId);
  } else if (!tab.active) {
    tab = await chrome.tabs.update(tabId, { active: true });
    await sleep(1200);
  }

  return tab;
}

async function notifyCaptureDone(candidateName) {
  const name = candidateName || "Profile";
  try {
    await chrome.notifications.create(`recruitme-done-${Date.now()}`, {
      type: "basic",
      iconUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAA7AAAAOwBeShxvQAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAAHpSURBVFiF7ZaxbtswEIa/o2zHhiEjQAYDHQIkQ4cCHQIUKFC0Q4c+QR8gj9CXyFP0EfoEfYU+Q5cgQ4ECBQoUCIokJMWS2CEt2ZItWxIlWxIlkSSboqoqVdX9cM/x7o47AgCO4zgOgJQSwB4ASinlnHMAOI7jOE8ppZQCAHgAIgB4AKICeAAgAnhRSnkDIOecAwDgnHMOAAB6AJ4BeALwBEAPwBMAD0AppdwB4A4AW2ttbQCklFJKKaWUUkoppZRSSilmAGCttbW2tpQCAIAQQgghhBBCCCGEEEIIIYQQQgghhBBCCCEAQAghgBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQggh5H8HYIwxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGAAAgAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQyY7QAAAAASUVORK5CYII=",
      title: "RecruitMe — Profile sent",
      message: `${name} has been captured and sent to RecruitMe for scoring.`,
      priority: 2,
    });
  } catch {
    // Notification permission not granted — not critical
  }
}

// Initiates an auto-capture: sends capture-and-post to content script which handles
// the full capture + POST to server independently of the service worker lifecycle.
async function initiateCapture(tabId, pending, preferredBase = "") {
  console.log("[RecruitMe] initiateCapture", { tabId, sessionId: pending.sessionId, url: pending.linkedinUrl });
  return sendMessageToTab(tabId, {
    type: "capture-and-post",
    sessionId: pending.sessionId,
    linkedinUrl: pending.linkedinUrl,
    serverBase: preferredBase,
  });
  // Content script has acked — it now handles capture + POST without the SW.
}

// Tracks sessions currently being captured. Key is sessionId (NOT sessionId:tabId)
// so the same session can never trigger duplicate captures across two tabs. Value is
// the timestamp the capture started — the lock auto-releases after 90s as a safety
// net, in case the content script never sends capture-complete/error.
const SESSION_LOCK_MAX_AGE_MS = 90_000;

function isSessionLocked(sessionId) {
  const startedAt = activeAutoCaptures.get(sessionId);
  if (!startedAt) return false;
  if (Date.now() - startedAt > SESSION_LOCK_MAX_AGE_MS) {
    activeAutoCaptures.delete(sessionId);
    return false;
  }
  return true;
}

async function capturePendingSessionInTab(tabId, pending, preferredBase = "") {
  if (isSessionLocked(pending.sessionId)) return;
  activeAutoCaptures.set(pending.sessionId, Date.now());

  try {
    await prepareTabForCapture(tabId, pending.linkedinUrl);
    await sleep(1400);
    try {
      const response = await initiateCapture(tabId, pending, preferredBase);
      if (response?.status !== "started" && response?.status !== "in-progress") {
        throw new Error("LinkedIn capture did not start");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Receiving end does not exist|Could not establish connection/i.test(message)) {
        await chrome.tabs.reload(tabId).catch(() => {});
        await waitForTabComplete(tabId);
        await sleep(1800);
        const response = await initiateCapture(tabId, pending, preferredBase);
        if (response?.status !== "started" && response?.status !== "in-progress") {
          throw new Error("LinkedIn capture did not start after reload");
        }
      } else {
        throw error;
      }
    }
    // Lock stays held until capture-complete / capture-error message clears it,
    // or until SESSION_LOCK_MAX_AGE_MS elapses (whichever comes first).
  } catch (error) {
    activeAutoCaptures.delete(pending.sessionId);
    await markPendingCaptureError(pending, error, preferredBase);
  }
}

async function maybeAutoCapture(tabId, linkedinUrl) {
  const pending = await checkPendingCapture(linkedinUrl);
  console.log("[RecruitMe] maybeAutoCapture", { tabId, linkedinUrl, status: pending.data?.status, sessionId: pending.data?.sessionId });
  if (!pending.data?.active || !pending.data?.sessionId) return;
  if (pending.data.status !== "pending") return;
  await capturePendingSessionInTab(tabId, pending.data, pending.base);
}

async function ensurePendingSessionTabs() {
  const { base, sessions } = await getPendingSessions();
  if (!sessions.length) return;

  for (const session of sessions) {
    if (pendingSessionEnsures.has(session.sessionId)) continue;

    pendingSessionEnsures.add(session.sessionId);
    try {
      const existingTab = await findLinkedInProfileTab(session.linkedinUrl);

      if (existingTab?.id) {
        if (existingTab.status === "complete") {
          await capturePendingSessionInTab(existingTab.id, session, base);
        }
        continue;
      }

      await openPendingProfileTab(session.linkedinUrl);
    } catch (error) {
      console.warn("RecruitMe pending-session ensure failed:", error);
    } finally {
      pendingSessionEnsures.delete(session.sessionId);
    }
  }
}

async function ensurePendingCaptureAlarm() {
  const existing = await chrome.alarms.get(PENDING_CAPTURE_ALARM);
  if (existing) return;
  await chrome.alarms.create(PENDING_CAPTURE_ALARM, { periodInMinutes: 0.5 });
}

async function getActiveLinkedInTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || !tab.url.includes("linkedin.com/in/")) {
    throw new Error("Open a LinkedIn profile first");
  }
  return tab;
}

// Manual capture (from popup button) — synchronous flow so popup gets real-time result.
async function doManualCapture(tabId, pending, preferredBase) {
  const capture = await sendMessageToTab(tabId, { type: "capture-profile" });
  return requestRecruitMe(
    "/api/extension/fetch-session/complete",
    {
      method: "POST",
      timeoutMs: 120000,
      body: JSON.stringify({
        sessionId: pending.sessionId,
        linkedinUrl: capture.data.linkedinUrl,
        profileText: capture.data.profileText,
      }),
    },
    preferredBase
  );
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "linkedin-page-observed") {
    const tabId = sender.tab?.id;
    if (!tabId || !message.linkedinUrl) {
      sendResponse({ ok: false, error: "Missing LinkedIn tab context" });
      return;
    }
    // Skip sub-pages like /details/experience — only capture from root profile pages
    if (!isRootLinkedInProfile(message.linkedinUrl)) {
      sendResponse({ ok: true, skipped: true });
      return false;
    }

    void maybeAutoCapture(tabId, message.linkedinUrl)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "capture-complete") {
    console.log("[RecruitMe] capture-complete", { sessionId: message.sessionId, candidateName: message.candidateName });
    if (message.sessionId) activeAutoCaptures.delete(message.sessionId);
    const tabId = sender.tab?.id;
    if (tabId && autoOpenedTabs.has(tabId)) {
      autoOpenedTabs.delete(tabId);
      chrome.tabs.remove(tabId).catch(() => {});
    }
    void notifyCaptureDone(message.candidateName).catch(() => {});
    void clearExtensionError().catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "capture-error") {
    console.log("[RecruitMe] capture-error", { sessionId: message.sessionId, error: message.error });
    if (message.sessionId) activeAutoCaptures.delete(message.sessionId);
    const tabId = sender.tab?.id;
    if (tabId && autoOpenedTabs.has(tabId)) {
      autoOpenedTabs.delete(tabId);
      chrome.tabs.remove(tabId).catch(() => {});
    }
    void setExtensionError(message.error || "Capture failed").catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "get-config") {
    void getStoredSettings()
      .then((settings) =>
        sendResponse({
          ok: true,
          serverBase: settings.serverBase || settings.lastWorkingServerBase || DEFAULT_SERVER_BASES[0],
          lastError: settings.lastError || "",
        })
      )
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "set-config") {
    void (async () => {
      const serverBase = normaliseServerBase(message.serverBase || "") || DEFAULT_SERVER_BASES[0];
      const { base } = await requestRecruitMe(
        "/api/extension/fetch-session",
        {},
        serverBase,
        { rememberFailure: false, allowFallback: false }
      );
      await chrome.storage.local.set({ serverBase, lastWorkingServerBase: base, lastError: "" });
      await ensurePendingCaptureAlarm();
      await ensurePendingSessionTabs().catch(() => {});
      return base;
    })()
      .then((base) => sendResponse({ ok: true, serverBase: base }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "get-session") {
    void requestRecruitMe("/api/extension/fetch-session")
      .then(({ base, data }) => sendResponse({ ok: true, session: data, serverBase: base }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "check-pending") {
    void checkPendingCapture(message.linkedinUrl)
      .then(({ base, data }) =>
        sendResponse({
          ok: true,
          pending: Boolean(data?.pending),
          active: Boolean(data?.active),
          status: data?.status || "idle",
          sessionId: data?.sessionId || "",
          candidateName: data?.candidateName || "",
          message: data?.message || "",
          error: data?.error || "",
          serverBase: base,
        })
      )
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "manual-capture-pending") {
    void (async () => {
      const tab = await getActiveLinkedInTab();
      const pending = await checkPendingCapture(tab.url);
      if (!pending.data?.active || !pending.data?.sessionId) {
        throw new Error("No pending RecruitMe fetch matches this LinkedIn profile");
      }
      if (pending.data.status === "processing") {
        throw new Error(pending.data.message || "RecruitMe is already scoring this profile");
      }
      if (pending.data.status === "completed") {
        throw new Error(pending.data.message || "RecruitMe already captured this profile");
      }
      if (pending.data.status === "error") {
        throw new Error(pending.data.error || pending.data.message || "Last RecruitMe capture failed");
      }
      if (!pending.data.pending) {
        throw new Error("No pending RecruitMe fetch matches this LinkedIn profile");
      }
      await doManualCapture(tab.id, pending.data, pending.base);
      const candidateName = pending.data.candidateName || "Profile";
      await notifyCaptureDone(candidateName);
      return candidateName;
    })()
      .then((candidateName) => sendResponse({ ok: true, candidateName }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  void ensurePendingCaptureAlarm();
  void clearExtensionError().catch(() => {});
  void ensurePendingSessionTabs().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  void ensurePendingCaptureAlarm();
  void ensurePendingSessionTabs().catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== PENDING_CAPTURE_ALARM) return;
  void ensurePendingSessionTabs().catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  // Only trigger for root profile pages; sub-pages like /details/experience are skipped
  if (!tab.url || !isRootLinkedInProfile(tab.url)) return;

  void maybeAutoCapture(tabId, tab.url.replace(/[?#].*$/, "")).catch((error) => {
    console.warn("RecruitMe auto-capture on tab update failed:", error);
  });
});

void ensurePendingCaptureAlarm();
void ensurePendingSessionTabs().catch(() => {});
