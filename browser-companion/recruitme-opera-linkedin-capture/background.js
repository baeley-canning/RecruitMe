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
const recentAutoCaptureLookups = new Map(); // url -> timestamp; throttles checkPendingCapture calls
const AUTO_CAPTURE_LOOKUP_COOLDOWN_MS = 12_000;
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
    extUsername: "",
    extPassword: "",
    // Default ON for new installs — protects users' LinkedIn accounts.
    // Auto-capture fires on every LinkedIn profile tab load, which LinkedIn
    // detects as automation. Manual-only means the user triggers each capture
    // deliberately from the popup; one profile at a time, human-paced.
    manualOnlyMode: true,
  });
}

// Build a Basic Authorization header from stored credentials, or return null.
async function getBasicAuthHeader() {
  const { extUsername, extPassword } = await getStoredSettings();
  if (!extUsername || !extPassword) return null;
  const encoded = btoa(`${extUsername}:${extPassword}`);
  return `Basic ${encoded}`;
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

  // Attach stored credentials automatically so every request is authenticated.
  const authHeader = await getBasicAuthHeader().catch(() => null);

  for (const base of bases) {
    try {
      const headers = new Headers(options.headers || {});
      const requestOptions = { ...options };
      delete requestOptions.timeoutMs;

      if (requestOptions.body && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }
      if (authHeader && !headers.has("Authorization")) {
        headers.set("Authorization", authHeader);
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

// Persist active captures to chrome.storage.session so the lock survives
// service worker restarts within the same browser session. When the SW is
// killed mid-capture the in-memory activeAutoCaptures Map is wiped, but the
// storage entry lives on — ensurePendingSessionTabs can check it before
// deciding to re-fire the alarm for a session that's still in-flight.
async function persistActiveCaptureStart(sessionId) {
  try {
    const stored = await chrome.storage.session.get({ activeCaptureIds: [] });
    const ids = new Set(stored.activeCaptureIds);
    ids.add(sessionId);
    await chrome.storage.session.set({ activeCaptureIds: [...ids] });
  } catch { /* non-fatal */ }
}
async function persistActiveCaptureEnd(sessionId) {
  try {
    const stored = await chrome.storage.session.get({ activeCaptureIds: [] });
    const ids = new Set(stored.activeCaptureIds);
    ids.delete(sessionId);
    await chrome.storage.session.set({ activeCaptureIds: [...ids] });
  } catch { /* non-fatal */ }
}
async function isCapturePersisted(sessionId) {
  try {
    const stored = await chrome.storage.session.get({ activeCaptureIds: [] });
    return stored.activeCaptureIds.includes(sessionId);
  } catch { return false; }
}

async function capturePendingSessionInTab(tabId, pending, preferredBase = "") {
  if (isSessionLocked(pending.sessionId)) return;
  // Also check the persisted set — covers SW-restart scenario where
  // activeAutoCaptures was wiped but the capture is still running.
  if (await isCapturePersisted(pending.sessionId)) return;

  activeAutoCaptures.set(pending.sessionId, Date.now());
  await persistActiveCaptureStart(pending.sessionId);

  try {
    await prepareTabForCapture(tabId, pending.linkedinUrl);
    await sleep(1400);
    let captureStarted = false;
    try {
      const response = await initiateCapture(tabId, pending, preferredBase);
      if (response?.status !== "started" && response?.status !== "in-progress") {
        throw new Error("LinkedIn capture did not start");
      }
      captureStarted = true;
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
        captureStarted = true;
      } else {
        throw error;
      }
    }

    // Advance the session to "processing" on the server as soon as content.js
    // confirms it has started. This prevents the alarm loop from treating the
    // session as still-pending and re-firing a duplicate capture while the first
    // one is running (the alarm fires every 30s; captures can take 30-60s).
    if (captureStarted) {
      requestRecruitMe(
        "/api/extension/fetch-session",
        { method: "PATCH", body: JSON.stringify({ sessionId: pending.sessionId, status: "processing" }) },
        preferredBase,
        { rememberFailure: false }
      ).catch(() => {}); // fire-and-forget; failure is non-fatal
    }

    // Lock stays held until capture-complete / capture-error message clears it,
    // or until SESSION_LOCK_MAX_AGE_MS elapses (whichever comes first).
  } catch (error) {
    activeAutoCaptures.delete(pending.sessionId);
    await persistActiveCaptureEnd(pending.sessionId);
    await markPendingCaptureError(pending, error, preferredBase);
  }
}

async function maybeAutoCapture(tabId, linkedinUrl) {
  // Manual-only mode: skip all auto-capture. The recruiter navigates to the
  // profile themselves and triggers capture via the popup. Toggle in Options.
  const { manualOnlyMode } = await chrome.storage.local.get({ manualOnlyMode: false });
  if (manualOnlyMode) {
    console.log("[RecruitMe] Auto-capture skipped (manual-only mode is ON)");
    return;
  }

  // Normalise trailing slash so "profile/" and "profile" share the same cooldown key.
  const normUrl = linkedinUrl.replace(/\/$/, "");
  const lastLookup = recentAutoCaptureLookups.get(normUrl);
  if (lastLookup && Date.now() - lastLookup < AUTO_CAPTURE_LOOKUP_COOLDOWN_MS) return;
  recentAutoCaptureLookups.set(normUrl, Date.now());

  const pending = await checkPendingCapture(linkedinUrl);
  console.log("[RecruitMe] maybeAutoCapture", { tabId, linkedinUrl, status: pending.data?.status, sessionId: pending.data?.sessionId });
  if (!pending.data?.active || !pending.data?.sessionId) return;
  if (pending.data.status !== "pending") return;
  await capturePendingSessionInTab(tabId, pending.data, pending.base);
}

const MAX_AUTO_OPEN_TABS = 3;

async function ensurePendingSessionTabs() {
  const { base, sessions } = await getPendingSessions();
  if (!sessions.length) return;

  let autoOpened = 0;
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

      if (autoOpened >= MAX_AUTO_OPEN_TABS) continue;
      autoOpened++;
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
    if (message.sessionId) {
      activeAutoCaptures.delete(message.sessionId);
      void persistActiveCaptureEnd(message.sessionId);
    }
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
    if (message.sessionId) {
      activeAutoCaptures.delete(message.sessionId);
      void persistActiveCaptureEnd(message.sessionId);
    }
    const tabId = sender.tab?.id;
    if (tabId && autoOpenedTabs.has(tabId)) {
      autoOpenedTabs.delete(tabId);
      chrome.tabs.remove(tabId).catch(() => {});
    }
    void setExtensionError(message.error || "Capture failed").catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  // Content script captured the profile and hands it to the service worker to POST.
  // Routing via the SW avoids cross-origin CORS ambiguity that content scripts have
  // when running inside a LinkedIn (or other) page context.
  if (message?.type === "submit-capture-result") {
    void (async () => {
      const { sessionId, linkedinUrl, profileText, candidateName, captureMeta, serverBase } = message;
      const tabId = sender.tab?.id;
      try {
        await requestRecruitMe(
          "/api/extension/fetch-session/complete",
          {
            method: "POST",
            timeoutMs: 120000,
            body: JSON.stringify({ sessionId, linkedinUrl, profileText, captureMeta }),
          },
          serverBase || "",
          { rememberFailure: false }
        );
        if (sessionId) { activeAutoCaptures.delete(sessionId); void persistActiveCaptureEnd(sessionId); }
        if (tabId && autoOpenedTabs.has(tabId)) {
          autoOpenedTabs.delete(tabId);
          chrome.tabs.remove(tabId).catch(() => {});
        }
        void notifyCaptureDone(candidateName || "").catch(() => {});
        void clearExtensionError().catch(() => {});
        sendResponse({ ok: true });
      } catch (error) {
        // POST failed — report error to server and set badge
        const errMsg = (error instanceof Error ? error.message : String(error)).slice(0, 500);
        console.warn("[RecruitMe] submit-capture-result failed:", errMsg);
        if (sessionId) { activeAutoCaptures.delete(sessionId); void persistActiveCaptureEnd(sessionId); }
        if (tabId && autoOpenedTabs.has(tabId)) {
          autoOpenedTabs.delete(tabId);
          chrome.tabs.remove(tabId).catch(() => {});
        }
        await requestRecruitMe(
          "/api/extension/fetch-session/error",
          { method: "POST", body: JSON.stringify({ sessionId, error: errMsg }) },
          serverBase || "",
          { rememberFailure: false }
        ).catch(() => {});
        await setExtensionError(errMsg).catch(() => {});
        sendResponse({ ok: false, error: errMsg });
      }
    })();
    return true;
  }

  // Content script captured an error — let the SW report it to the server.
  if (message?.type === "submit-capture-error") {
    void (async () => {
      const { sessionId, error: errMsg, serverBase } = message;
      const tabId = sender.tab?.id;
      if (sessionId) { activeAutoCaptures.delete(sessionId); void persistActiveCaptureEnd(sessionId); }
      if (tabId && autoOpenedTabs.has(tabId)) {
        autoOpenedTabs.delete(tabId);
        chrome.tabs.remove(tabId).catch(() => {});
      }
      await requestRecruitMe(
        "/api/extension/fetch-session/error",
        { method: "POST", body: JSON.stringify({ sessionId, error: errMsg }) },
        serverBase || "",
        { rememberFailure: false }
      ).catch(() => {});
      await setExtensionError(errMsg || "Capture failed").catch(() => {});
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message?.type === "get-config") {
    void getStoredSettings()
      .then((settings) =>
        sendResponse({
          ok: true,
          serverBase: settings.serverBase || settings.lastWorkingServerBase || DEFAULT_SERVER_BASES[0],
          username:   settings.extUsername || "",
          lastError:  settings.lastError || "",
        })
      )
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "set-config") {
    void (async () => {
      const serverBase = normaliseServerBase(message.serverBase || "") || DEFAULT_SERVER_BASES[0];
      // Store credentials before the connection test so requestRecruitMe picks them up.
      if (message.username !== undefined) {
        await chrome.storage.local.set({
          extUsername: message.username || "",
          extPassword: message.password || "",
        });
      }
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

  if (message?.type === "get-active-jobs") {
    void requestRecruitMe("/api/extension/jobs")
      .then(({ data }) => sendResponse({ ok: true, jobs: data || [] }))
      .catch((error) => sendResponse({ ok: false, jobs: [], error: error.message }));
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

  // Q2.3: ask the server which jobs already include this LinkedIn URL and
  // which active jobs the candidate could be added to. Used by the in-page
  // overlay so the recruiter sees match info without leaving the profile.
  if (message?.type === "query-profile-match") {
    if (!message.linkedinUrl) {
      sendResponse({ ok: false, error: "linkedinUrl required" });
      return false;
    }
    void requestRecruitMe(
      `/api/extension/profile-match?url=${encodeURIComponent(message.linkedinUrl)}`,
      {},
      "",
      { rememberFailure: false }
    )
      .then(({ data, base }) => sendResponse({ ok: true, data, serverBase: base }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  // Q2.3: manual "Add to {job}" path. Captures via the content script first,
  // then POSTs the captured profileText to /api/extension/import bound to the
  // chosen job. Mirrors the auto-capture flow but without a server-side
  // pending FetchSession — recruiter intent comes from the overlay click.
  if (message?.type === "submit-add-to-job") {
    const { jobId, linkedinUrl, profileText, captureMeta } = message;
    if (!jobId || !linkedinUrl || !profileText) {
      sendResponse({ ok: false, error: "jobId, linkedinUrl, profileText required" });
      return false;
    }
    void requestRecruitMe(
      "/api/extension/import",
      {
        method: "POST",
        timeoutMs: 90000,
        body: JSON.stringify({ jobId, linkedinUrl, profileText, captureMeta }),
      },
      "",
      { rememberFailure: false }
    )
      .then(({ data }) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "log-contact") {
    const { candidateId, contactType, note } = message;
    if (!candidateId || !contactType) {
      sendResponse({ ok: false, error: "candidateId and contactType required" });
      return false;
    }
    void requestRecruitMe(
      `/api/candidates/${encodeURIComponent(candidateId)}/contacts`,
      {
        method: "POST",
        timeoutMs: 10000,
        body: JSON.stringify({ type: contactType, note: note || undefined }),
      },
      "",
      { rememberFailure: false }
    )
      .then(({ data }) => sendResponse({ ok: true, data }))
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

async function checkForExtensionUpdate() {
  try {
    const bases = await getServerBases();
    const preferredBase = bases[0] || "";
    for (const base of bases) {
      try {
        const res = await fetch(`${base}/api/extension/version`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) continue;
        const data = await res.json();
        const latestVersion = data?.version;
        const manifest = chrome.runtime.getManifest();
        const currentVersion = manifest.version;
        if (latestVersion && latestVersion !== currentVersion) {
          await chrome.action.setBadgeText({ text: "!" });
          await chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" });
          await chrome.action.setTitle({ title: `RecruitMe update available (${currentVersion} → ${latestVersion}). Visit LinkedIn Setup in the app to download.` });
          console.log(`[RecruitMe] Extension update available: ${currentVersion} → ${latestVersion}`);
        }
        return;
      } catch { /* try next base */ }
    }
  } catch { /* non-fatal */ }
}

// Run ensurePendingSessionTabs only when auto-capture is enabled.
// Calling it unconditionally would trigger captures on startup even when
// manual-only mode is on, marking sessions "processing" before the user
// has a chance to click Capture in the popup.
async function maybeEnsurePendingSessionTabs() {
  const { manualOnlyMode } = await chrome.storage.local.get({ manualOnlyMode: true });
  if (manualOnlyMode) return;
  void ensurePendingSessionTabs().catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => {
  void ensurePendingCaptureAlarm();
  void clearExtensionError().catch(() => {});
  void maybeEnsurePendingSessionTabs();
  void checkForExtensionUpdate().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  void ensurePendingCaptureAlarm();
  void maybeEnsurePendingSessionTabs();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== PENDING_CAPTURE_ALARM) return;
  // Skip the background tab-opening loop when manual-only mode is on.
  chrome.storage.local.get({ manualOnlyMode: false }, ({ manualOnlyMode }) => {
    if (manualOnlyMode) return;
    void ensurePendingSessionTabs().catch(() => {});
  });
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
void maybeEnsurePendingSessionTabs();
