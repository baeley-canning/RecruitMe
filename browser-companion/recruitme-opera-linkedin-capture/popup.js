const serverBaseInput = document.getElementById("serverBase");
const authUserInput = document.getElementById("authUser");
const authPassInput = document.getElementById("authPass");
const saveServerButton = document.getElementById("saveServer");
const serverStatus = document.getElementById("serverStatus");
const pageStatus = document.getElementById("pageStatus");
const capturePendingButton = document.getElementById("capturePending");
const pendingStatus = document.getElementById("pendingStatus");
const jobSelect = document.getElementById("jobSelect");
const importProfileButton = document.getElementById("importProfile");
const importStatus = document.getElementById("importStatus");

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

async function getActiveLinkedInProfileUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !tab.url.includes("linkedin.com/in/")) {
    throw new Error("Open a LinkedIn profile in the current tab first");
  }
  return tab.url.replace(/[?#].*$/, "");
}

async function loadConfig() {
  try {
    const response = await sendMessage({ type: "get-config" });
    serverBaseInput.value = response.serverBase || "http://localhost:3000";
    authUserInput.value = response.authUser || "";
    authPassInput.value = response.authPass || "";
  } catch (error) {
    setStatus(serverStatus, error.message, "error");
  }
}

async function loadJobs() {
  jobSelect.innerHTML = "";
  importProfileButton.disabled = false;

  try {
    const response = await sendMessage({ type: "get-jobs" });
    response.jobs.forEach((job) => {
      const option = document.createElement("option");
      option.value = job.id;
      option.textContent = `${job.title} - ${job.company || "Unknown"} (${job.candidateCount})`;
      jobSelect.appendChild(option);
    });

    if (!response.jobs.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No active jobs";
      jobSelect.appendChild(option);
      importProfileButton.disabled = true;
    }
  } catch (error) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Could not load jobs";
    jobSelect.appendChild(option);
    importProfileButton.disabled = true;
    setStatus(importStatus, error.message, "error");
  }
}

function normaliseLinkedInSlug(url) {
  const m = url.match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  return m ? m[1].toLowerCase() : "";
}

async function refreshPendingStatus() {
  // 1. Check current tab (non-fatal if not LinkedIn)
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

  // 2. Fetch current sessions (GET returns null or an array when the multi-session queue is active).
  let session = null;
  try {
    const response = await sendMessage({ type: "get-session" });
    const sessionData = response.session;
    // Normalise: could be a single object (legacy) or an array (queue).
    const sessions = Array.isArray(sessionData)
      ? sessionData
      : sessionData
      ? [sessionData]
      : [];

    // Prefer the session matching the current tab URL; fall back to first pending one.
    const tabSlugNow = normaliseLinkedInSlug(currentTabUrl);
    session =
      sessions.find((s) => normaliseLinkedInSlug(s.linkedinUrl) === tabSlugNow) ||
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
  const urlMatches = sessionSlug && tabSlug && sessionSlug === tabSlug;

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
  setStatus(serverStatus, "Saving...");
  try {
    await sendMessage({
      type: "set-config",
      serverBase: serverBaseInput.value,
      authUser: authUserInput.value,
      authPass: authPassInput.value,
    });
    setStatus(serverStatus, "Connection saved.", "ok");
    await loadJobs();
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

importProfileButton.addEventListener("click", async () => {
  if (!jobSelect.value) return;

  importProfileButton.disabled = true;
  setStatus(importStatus, "Capturing current LinkedIn profile...");
  try {
    const response = await sendMessage({ type: "manual-import", jobId: jobSelect.value });
    setStatus(importStatus, `Imported ${response.candidate.name} into RecruitMe.`, "ok");
  } catch (error) {
    setStatus(importStatus, error.message, "error");
  } finally {
    importProfileButton.disabled = false;
  }
});

void loadConfig();
void loadJobs();
void refreshPendingStatus();
setInterval(() => {
  void refreshPendingStatus();
}, 2000);
