const serverBaseInput = document.getElementById("serverBase");
const saveServerButton = document.getElementById("saveServer");
const serverStatus = document.getElementById("serverStatus");
const pageStatus = document.getElementById("pageStatus");
const capturePendingButton = document.getElementById("capturePending");
const pendingStatus = document.getElementById("pendingStatus");

function setStatus(element, message, kind = "") {
  element.textContent = message;
  element.className = kind ? `status ${kind}` : "status";
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "RecruitMe extension request failed"));
        return;
      }
      resolve(response);
    });
  });
}

async function loadConfig() {
  try {
    const response = await sendMessage({ type: "get-config" });
    serverBaseInput.value = response.serverBase || "";
    if (response.lastError) {
      setStatus(serverStatus, response.lastError, "error");
    }
  } catch (error) {
    setStatus(serverStatus, error.message, "error");
  }
}

function normaliseLinkedInSlug(url) {
  const m = url.match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  return m ? m[1].toLowerCase() : "";
}

function linkedInSlugAliasKey(url) {
  return normaliseLinkedInSlug(url)
    .replace(/-[a-z0-9]*\d[a-z0-9]{5,}$/i, "")
    .replace(/[^a-z0-9]/g, "");
}

function linkedInProfileMatches(a, b) {
  const aSlug = normaliseLinkedInSlug(a);
  const bSlug = normaliseLinkedInSlug(b);
  if (!aSlug || !bSlug) return false;
  if (aSlug === bSlug) return true;

  const aKey = linkedInSlugAliasKey(a);
  const bKey = linkedInSlugAliasKey(b);
  return aKey.length >= 6 && aKey === bKey;
}

async function refreshPendingStatus() {
  let currentTabUrl = "";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url?.includes("linkedin.com/in/")) {
      currentTabUrl = tab.url.replace(/[?#].*$/, "");
      pageStatus.textContent = `Current: ${normaliseLinkedInSlug(currentTabUrl)}`;
    } else {
      pageStatus.textContent = "Current tab is not a LinkedIn profile";
    }
  } catch {
    pageStatus.textContent = "Could not read current tab";
  }

  let session = null;
  try {
    const response = await sendMessage({ type: "get-session" });
    const sessionData = response.session;
    const sessions = Array.isArray(sessionData) ? sessionData : sessionData ? [sessionData] : [];

    session =
      sessions.find((s) => linkedInProfileMatches(s.linkedinUrl, currentTabUrl)) ||
      sessions.find((s) => s.status === "pending") ||
      sessions[0] ||
      null;
  } catch (error) {
    capturePendingButton.disabled = true;
    setStatus(pendingStatus, error.message, "error");
    return;
  }

  if (!session) {
    capturePendingButton.disabled = true;
    setStatus(pendingStatus, "No pending RecruitMe fetch — click Fetch Profile on a candidate first.");
    return;
  }

  const sessionSlug = normaliseLinkedInSlug(session.linkedinUrl);
  const tabSlug = normaliseLinkedInSlug(currentTabUrl);
  const urlMatches = linkedInProfileMatches(session.linkedinUrl, currentTabUrl);

  if (session.status === "pending") {
    if (urlMatches) {
      setStatus(pendingStatus, `Ready to capture ${session.candidateName || "this candidate"}`, "ok");
      capturePendingButton.disabled = false;
    } else {
      setStatus(
        pendingStatus,
        `Navigate to linkedin.com/in/${sessionSlug} to capture ${session.candidateName || "this candidate"}`
      );
      capturePendingButton.disabled = true;
    }
    return;
  }

  if (session.status === "processing") {
    setStatus(pendingStatus, session.message || `Scoring ${session.candidateName || "profile"}…`, "ok");
    capturePendingButton.disabled = true;
    return;
  }

  if (session.status === "completed") {
    setStatus(pendingStatus, session.message || `Captured ${session.candidateName || "profile"} ✓`, "ok");
    capturePendingButton.disabled = true;
    return;
  }

  if (session.status === "error") {
    setStatus(pendingStatus, session.error || session.message || "Last capture failed.", "error");
    capturePendingButton.disabled = true;
    return;
  }

  capturePendingButton.disabled = true;
  setStatus(pendingStatus, "No pending RecruitMe fetch.");
}

saveServerButton.addEventListener("click", async () => {
  setStatus(serverStatus, "Testing RecruitMe connection...");
  try {
    const response = await sendMessage({
      type: "set-config",
      serverBase: serverBaseInput.value,
    });
    setStatus(serverStatus, `Connected to ${response.serverBase}`, "ok");
    await refreshPendingStatus();
  } catch (error) {
    setStatus(serverStatus, error.message, "error");
  }
});

capturePendingButton.addEventListener("click", async () => {
  capturePendingButton.disabled = true;
  setStatus(pendingStatus, "Capturing pending RecruitMe fetch...");
  try {
    const response = await sendMessage({ type: "manual-capture-pending" });
    setStatus(
      pendingStatus,
      `Captured and sent ${response.candidateName || "profile"} to RecruitMe.`,
      "ok"
    );
  } catch (error) {
    setStatus(pendingStatus, error.message, "error");
  } finally {
    await refreshPendingStatus();
  }
});

void loadConfig();
void refreshPendingStatus();
setInterval(() => {
  void refreshPendingStatus();
}, 2000);
