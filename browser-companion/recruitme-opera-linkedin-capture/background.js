const DEFAULT_SERVER_BASES = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://10.255.255.254:3000",
];

const activeAutoCaptures = new Set();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getStoredSettings() {
  return chrome.storage.local.get({
    serverBase: "",
    lastWorkingServerBase: "",
    authUser: "",
    authPass: "",
  });
}

async function getServerBases() {
  const settings = await getStoredSettings();
  const bases = [
    settings.serverBase?.trim(),
    settings.lastWorkingServerBase?.trim(),
    ...DEFAULT_SERVER_BASES,
  ].filter(Boolean);
  return [...new Set(bases)];
}

function withTimeout(url, options = {}, timeoutMs = 4000) {
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

async function requestRecruitMe(path, options = {}, preferredBase = "") {
  const settings = await getStoredSettings();
  const bases = preferredBase
    ? [preferredBase, ...(await getServerBases()).filter((base) => base !== preferredBase)]
    : await getServerBases();

  let lastError = new Error("Could not connect to RecruitMe");

  for (const base of bases) {
    try {
      const headers = new Headers(options.headers || {});
      if (options.body && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }
      if (settings.authUser || settings.authPass) {
        headers.set("Authorization", `Basic ${btoa(`${settings.authUser}:${settings.authPass}`)}`);
      }

      const response = await withTimeout(`${base}${path}`, { ...options, headers });
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
        if (response.status === 401) {
          lastError = new Error(
            "RecruitMe returned 401 Unauthorized. Save the same username and password you use in the browser."
          );
        } else {
          lastError = new Error(data?.error || `RecruitMe request failed (${response.status})`);
        }
        continue;
      }

      await chrome.storage.local.set({ lastWorkingServerBase: base });
      return { base, data };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError;
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
      resolve(response.data);
    });
  });
}

async function checkPendingCapture(linkedinUrl) {
  const { base, data } = await requestRecruitMe(
    `/api/extension/fetch-session/pending?linkedinUrl=${encodeURIComponent(linkedinUrl)}`
  );
  return { base, data };
}

async function completePendingCapture(tabId, pending, preferredBase = "") {
  const capture = await sendMessageToTab(tabId, { type: "capture-profile" });
  return requestRecruitMe(
    "/api/extension/fetch-session/complete",
    {
      method: "POST",
      body: JSON.stringify({
        sessionId: pending.sessionId,
        linkedinUrl: capture.linkedinUrl,
        profileText: capture.profileText,
      }),
    },
    preferredBase
  );
}

async function maybeAutoCapture(tabId, linkedinUrl) {
  const lockKey = `${tabId}:${linkedinUrl}`;
  if (activeAutoCaptures.has(lockKey)) return;

  const pending = await checkPendingCapture(linkedinUrl);
  if (!pending.data?.pending || !pending.data?.sessionId) return;

  activeAutoCaptures.add(lockKey);
  try {
    await sleep(600);
    await completePendingCapture(tabId, pending.data, pending.base);
  } catch (error) {
    console.warn("RecruitMe auto-capture failed:", error);
  } finally {
    activeAutoCaptures.delete(lockKey);
  }
}

async function getActiveLinkedInTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || !tab.url.includes("linkedin.com/in/")) {
    throw new Error("Open a LinkedIn profile first");
  }
  return tab;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "linkedin-page-observed") {
    const tabId = sender.tab?.id;
    if (!tabId || !message.linkedinUrl) {
      sendResponse({ ok: false, error: "Missing LinkedIn tab context" });
      return;
    }

    void maybeAutoCapture(tabId, message.linkedinUrl)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "get-config") {
    void getStoredSettings()
      .then((settings) =>
        sendResponse({
          ok: true,
          serverBase: settings.serverBase || settings.lastWorkingServerBase || DEFAULT_SERVER_BASES[0],
          authUser: settings.authUser || "",
          authPass: settings.authPass || "",
        })
      )
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "set-config") {
    void chrome.storage.local
      .set({
        serverBase: (message.serverBase || "").trim(),
        authUser: (message.authUser || "").trim(),
        authPass: message.authPass || "",
      })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "get-jobs") {
    void requestRecruitMe("/api/extension/jobs")
      .then(({ base, data }) => sendResponse({ ok: true, jobs: data, serverBase: base }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "get-session") {
    // Returns the current session (any URL) or null — used by popup for status display.
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
      if (!pending.data?.pending || !pending.data?.sessionId) {
        throw new Error("No pending RecruitMe fetch matches this LinkedIn profile");
      }
      await completePendingCapture(tab.id, pending.data, pending.base);
      return pending.data.candidateName || "Profile";
    })()
      .then((candidateName) => sendResponse({ ok: true, candidateName }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "manual-import") {
    void (async () => {
      const tab = await getActiveLinkedInTab();
      const capture = await sendMessageToTab(tab.id, { type: "capture-profile" });
      const imported = await requestRecruitMe("/api/extension/import", {
        method: "POST",
        body: JSON.stringify({
          jobId: message.jobId,
          linkedinUrl: capture.linkedinUrl,
          profileText: capture.profileText,
        }),
      });
      return imported.data;
    })()
      .then((candidate) => sendResponse({ ok: true, candidate }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});
