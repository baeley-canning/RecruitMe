const settingsBtn       = document.getElementById("settingsBtn");
const openSettingsBtn   = document.getElementById("openSettingsBtn");
const connectionStatus  = document.getElementById("connectionStatus");
const statusDot         = document.getElementById("statusDot");
const statusLabel       = document.getElementById("statusLabel");
const pageStatus        = document.getElementById("pageStatus");
const capturePendingButton = document.getElementById("capturePending");
const pendingStatus     = document.getElementById("pendingStatus");
const setupCard         = document.getElementById("setupCard");

function openSettings() {
  chrome.runtime.openOptionsPage();
}

settingsBtn.addEventListener("click", openSettings);
openSettingsBtn.addEventListener("click", openSettings);

function setConnectionState(state, label) {
  const dotClass = { ok: "green", error: "red", unconfigured: "grey" }[state] ?? "grey";
  const bgClass  = { ok: "ok",    error: "error", unconfigured: "unconfigured" }[state] ?? "unconfigured";
  connectionStatus.className = `connection ${bgClass}`;
  statusDot.className        = `dot ${dotClass}`;
  statusLabel.textContent    = label;
  setupCard.style.display    = state === "unconfigured" ? "block" : "none";
}

function setStatus(element, message, kind = "") {
  element.textContent = message;
  element.className   = kind ? `status ${kind}` : "status";
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Request failed"));
        return;
      }
      resolve(response);
    });
  });
}

async function refreshPendingStatus() {
  try {
    const response = await sendMessage({ type: "get-session" });
    const session  = response.session;

    if (!session) {
      setStatus(pendingStatus, "No pending RecruitMe fetch.");
      capturePendingButton.disabled = true;
      return;
    }

    const name = session.candidateName || session.linkedinUrl || "candidate";
    const isScraperSession = (session.message || "").toLowerCase().includes("scraper");

    if (session.status === "pending") {
      // Scraper owns this — don't offer manual capture
      if (isScraperSession) {
        setStatus(pendingStatus, `Server scraper queued for ${name} — no action needed.`, "ok");
        capturePendingButton.disabled = true;
      } else {
        setStatus(pendingStatus, `Ready to capture ${name}.`, "ok");
        capturePendingButton.disabled = false;
      }
      return;
    }
    if (session.status === "processing") {
      setStatus(pendingStatus, isScraperSession
        ? `Scraper capturing ${name} (~5–8 min)…`
        : `Scoring ${name}…`
      );
      capturePendingButton.disabled = true;
      return;
    }
    if (session.status === "completed") {
      setStatus(pendingStatus, `${name} captured and scored.`, "ok");
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
  } catch {
    capturePendingButton.disabled = true;
  }
}

async function init() {
  // Check if configured and connected
  try {
    const config = await sendMessage({ type: "get-config" });
    if (!config.serverBase || !config.username) {
      setConnectionState("unconfigured", "Not configured — open settings to connect");
      pageStatus.textContent = "";
      return;
    }
    // Show connected state immediately using stored server
    const host = (() => { try { return new URL(config.serverBase).hostname; } catch { return config.serverBase; } })();
    setConnectionState("ok", `Connected · ${host}`);
    if (config.lastError) {
      setConnectionState("error", config.lastError.slice(0, 60));
    }
  } catch {
    setConnectionState("unconfigured", "Not configured — open settings to connect");
    pageStatus.textContent = "";
    return;
  }

  // Check current tab
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url?.includes("linkedin.com/in/")) {
      pageStatus.textContent = "On a LinkedIn profile.";
    } else {
      pageStatus.textContent = "Navigate to a LinkedIn profile to capture.";
    }
  } catch {
    pageStatus.textContent = "";
  }

  await refreshPendingStatus();
}

capturePendingButton.addEventListener("click", async () => {
  capturePendingButton.disabled = true;
  setStatus(pendingStatus, "Capturing…");
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

void init();
setInterval(() => { void refreshPendingStatus(); }, 2000);
