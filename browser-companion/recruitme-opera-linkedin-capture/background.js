const DEFAULT_SERVER_BASES = [
  "https://recruitme-production-8cc6.up.railway.app",
  "https://recruitme.railway.app",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://10.255.255.254:3000",
];

const PENDING_CAPTURE_ALARM = "recruitme-pending-capture-check";
const activeAutoCaptures = new Set();
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
  const bases = preferredBase
    ? [preferredBase, ...(await getServerBases()).filter((base) => base !== preferredBase)]
    : await getServerBases();
  const rememberFailure = overrides.rememberFailure !== false;
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
    return "LinkedIn did not expose enough profile content to capture. Open the full profile and try again.";
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
  const { base, data } = await requestRecruitMe(
    `/api/extension/fetch-session/pending?linkedinUrl=${encodeURIComponent(linkedinUrl)}`
  );
  return { base, data };
}

async function getPendingSessions() {
  const { base, data } = await requestRecruitMe("/api/extension/fetch-session");
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

async function findLinkedInProfileTab(linkedinUrl) {
  const targetUrl = normaliseLinkedInUrl(linkedinUrl);
  if (!targetUrl) return null;

  const tabs = await chrome.tabs.query({ url: ["https://www.linkedin.com/in/*"] });
  return tabs.find((tab) => normaliseLinkedInUrl(tab.url) === targetUrl) || null;
}

async function openPendingProfileTab(linkedinUrl) {
  // active: true ensures LinkedIn renders all sections via IntersectionObserver
  // (background tabs have innerHeight=0 so lazy sections never load → "too short")
  const created = await chrome.tabs.create({ url: linkedinUrl, active: true });
  const tabId = created?.id ?? null;
  if (tabId) autoOpenedTabs.add(tabId);
  return tabId;
}

async function notifyCaptureDone(candidateName) {
  const name = candidateName || "Profile";
  try {
    await chrome.notifications.create(`recruitme-done-${Date.now()}`, {
      type: "basic",
      iconUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAA7AAAAOwBeShxvQAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAAHpSURBVFiF7ZaxbtswEIa/o2zHhiEjQAYDHQIkQ4cCHQIUKFC0Q4c+QR8gj9CXyFP0EfoEfYU+Q5cgQ4ECBQoUCIokJMWS2CEt2ZItWxIlWxIlkSSboqoqVdX9cM/x7o47AgCO4zgOgJQSwB4ASinlnHMAOI7jOE8ppZQCAHgAIgB4AKICeAAgAnhRSnkDIOecAwDgnHMOAAB6AJ4BeALwBEAPwBMAD0AppdwB4A4AW2ttbQCklFJKKaWUUkoppZRSSilmAGCttbW2tpQCAIAQQgghhBBCCCGEEEIIIYQQQgghhBBCCCEAQAghgBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQggh5H8HYIwxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGAAAgAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQyY7QAAAAASUVORK5CYII=",
      title: "RecruitMe — Profile captured",
      message: `${name} has been captured and scored.`,
      priority: 2,
    });
  } catch {
    // Notification permission not granted — not critical
  }
}

// Initiates an auto-capture: sends capture-and-post to content script which handles
// the full capture + POST to server independently of the service worker lifecycle.
async function initiateCapture(tabId, pending, preferredBase = "") {
  await sendMessageToTab(tabId, {
    type: "capture-and-post",
    sessionId: pending.sessionId,
    linkedinUrl: pending.linkedinUrl,
    serverBase: preferredBase,
  });
  // Content script has acked — it now handles capture + POST without the SW.
}

async function capturePendingSessionInTab(tabId, pending, preferredBase = "") {
  const lockKey = `${pending.sessionId}:${tabId}`;
  if (activeAutoCaptures.has(lockKey)) return;

  activeAutoCaptures.add(lockKey);
  try {
    await sleep(600);
    await initiateCapture(tabId, pending, preferredBase);
  } catch (error) {
    await markPendingCaptureError(pending, error, preferredBase);
  } finally {
    activeAutoCaptures.delete(lockKey);
  }
}

async function maybeAutoCapture(tabId, linkedinUrl) {
  const pending = await checkPendingCapture(linkedinUrl);
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
        { rememberFailure: false }
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
