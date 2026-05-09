const settingsBtn       = document.getElementById("settingsBtn");
const openSettingsBtn   = document.getElementById("openSettingsBtn");
const connectionStatus  = document.getElementById("connectionStatus");
const statusDot         = document.getElementById("statusDot");
const statusLabel       = document.getElementById("statusLabel");
const pageStatus        = document.getElementById("pageStatus");
const capturePendingButton = document.getElementById("capturePending");
const pendingStatus     = document.getElementById("pendingStatus");
const setupCard         = document.getElementById("setupCard");
const autoCaptureCard   = document.getElementById("autoCaptureCard");
const autoCaptureLine   = document.getElementById("autoCaptureLine");
const autoCaptureCounts = document.getElementById("autoCaptureCounts");
const recentCaptures      = document.getElementById("recentCaptures");
const recentCapturesList  = document.getElementById("recentCapturesList");

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

function fmtCountdown(epochMs) {
  const ms = epochMs - Date.now();
  if (ms <= 0) return "now";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h > 0) return `in ${h}h ${m}m`;
  return `in ${m}m`;
}

function fmtRelativeAgo(epochMs) {
  const ms = Date.now() - epochMs;
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function refreshAutoCaptureCard() {
  try {
    const r = await sendMessage({ type: "get-auto-capture-status" });
    if (r.manualOnlyMode) {
      autoCaptureCard.style.display = "none";
      return;
    }
    autoCaptureCard.style.display = "block";
    if (r.paused) {
      autoCaptureLine.textContent = `Paused — resumes ${fmtCountdown(r.pausedUntil)}`;
      autoCaptureLine.style.color = "#b45309";
    } else if (r.hourly >= r.hourlyCap || r.daily >= r.dailyCap) {
      autoCaptureLine.textContent = "Cap reached — waiting for the window to roll over";
      autoCaptureLine.style.color = "#b45309";
    } else if (Array.isArray(r.recentCaptures) && r.recentCaptures.length > 0 && Date.now() - r.recentCaptures[0].at < 5 * 60_000) {
      // Highlight a fresh capture for ~5 min so the recruiter sees their
      // last result clearly when they open the popup.
      const last = r.recentCaptures[0];
      autoCaptureLine.textContent = `✔ Captured ${last.name} ${fmtRelativeAgo(last.at)}`;
      autoCaptureLine.style.color = "#047857";
    } else {
      autoCaptureLine.textContent = "Active — capturing one profile every 90–240s";
      autoCaptureLine.style.color = "#047857";
    }
    autoCaptureCounts.textContent = `${r.hourly}/${r.hourlyCap} this hour · ${r.daily}/${r.dailyCap} today`;

    // Render the recent-captures rolling history (last 5).
    if (Array.isArray(r.recentCaptures) && r.recentCaptures.length > 0) {
      recentCaptures.style.display = "block";
      recentCapturesList.innerHTML = r.recentCaptures.slice(0, 5).map((c) => {
        const safeName = escapeHtml(c.name ?? "candidate");
        return `<p class="tiny" style="margin:2px 0;color:#475569;display:flex;justify-content:space-between;gap:8px;">
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">✔ ${safeName}</span>
          <span style="color:#94a3b8;flex-shrink:0;">${fmtRelativeAgo(c.at)}</span>
        </p>`;
      }).join("");
    } else {
      recentCaptures.style.display = "none";
    }
  } catch {
    autoCaptureCard.style.display = "none";
  }
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

    if (session.status === "pending") {
      setStatus(pendingStatus, `Ready to capture ${name}.`, "ok");
      capturePendingButton.disabled = false;
      return;
    }
    if (session.status === "processing") {
      setStatus(pendingStatus, `Scoring ${name}…`);
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
void refreshAutoCaptureCard();
setInterval(() => { void refreshPendingStatus(); }, 2000);
setInterval(() => { void refreshAutoCaptureCard(); }, 5000);
