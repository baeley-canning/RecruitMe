const serverBaseInput  = document.getElementById("serverBase");
const extUsernameInput = document.getElementById("extUsername");
const extPasswordInput = document.getElementById("extPassword");
const saveBtn          = document.getElementById("saveBtn");
const saveStatus       = document.getElementById("saveStatus");
const connectionBadge  = document.getElementById("connectionBadge");
const statusDot        = document.getElementById("statusDot");
const statusText       = document.getElementById("statusText");
const manualOnlyToggle = document.getElementById("manualOnlyToggle");
const manualOnlyRow    = document.getElementById("manualOnlyRow");
const manualOnlyHint   = document.getElementById("manualOnlyHint");

function setManualOnlyUI(enabled) {
  manualOnlyToggle.checked = enabled;
  manualOnlyRow.className = "toggle-row" + (enabled ? " active" : "");
  manualOnlyHint.innerHTML = enabled
    ? "<strong>Manual-only is ON</strong> — auto-capture is paused. Navigate to a LinkedIn profile yourself and click the extension icon to capture manually."
    : "Auto-capture is <strong>on</strong> — the extension opens tabs and captures profiles automatically when a fetch is queued.";
}

manualOnlyToggle.addEventListener("change", async () => {
  const enabled = manualOnlyToggle.checked;
  await chrome.storage.local.set({ manualOnlyMode: enabled });
  setManualOnlyUI(enabled);
});

function setStatus(element, message, kind = "") {
  element.textContent = message;
  element.className   = kind ? `status ${kind}` : "status";
}

function setConnectionBadge(state, label) {
  const classes = { connected: "connected", disconnected: "disconnected", unconfigured: "unconfigured" };
  const dots    = { connected: "green",     disconnected: "red",          unconfigured: "grey" };
  connectionBadge.className = `connection-badge ${classes[state] ?? "unconfigured"}`;
  statusDot.className       = `dot ${dots[state] ?? "grey"}`;
  statusText.textContent    = label;
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

// Load stored settings and check connection on page open.
async function init() {
  try {
    // Load manual-only mode separately (doesn't go through background)
    const stored = await chrome.storage.local.get({ manualOnlyMode: false });
    setManualOnlyUI(stored.manualOnlyMode);

    const response = await sendMessage({ type: "get-config" });
    serverBaseInput.value  = response.serverBase || "";
    extUsernameInput.value = response.username   || "";
    // Never pre-fill password

    if (response.serverBase && response.username) {
      // Try a live connection check
      try {
        await sendMessage({ type: "set-config", serverBase: response.serverBase });
        setConnectionBadge("connected", `Connected · ${new URL(response.serverBase).hostname}`);
      } catch {
        setConnectionBadge("disconnected", "Saved — but connection test failed. Check URL and credentials.");
      }
    } else {
      setConnectionBadge("unconfigured", "Not configured — fill in the fields below and save.");
    }
  } catch (error) {
    setConnectionBadge("unconfigured", "Could not load saved settings.");
  }
}

saveBtn.addEventListener("click", async () => {
  const serverBase = serverBaseInput.value.trim();
  const username   = extUsernameInput.value.trim();
  const password   = extPasswordInput.value;

  if (!serverBase) {
    setStatus(saveStatus, "Enter your RecruitMe server URL.", "error");
    return;
  }
  if (!username || !password) {
    setStatus(saveStatus, "Enter your username and password.", "error");
    return;
  }

  saveBtn.disabled = true;
  setStatus(saveStatus, "Testing connection…", "info");
  setConnectionBadge("unconfigured", "Connecting…");

  try {
    const response = await sendMessage({
      type:       "set-config",
      serverBase,
      username,
      password,
    });
    setConnectionBadge("connected", `Connected · ${new URL(response.serverBase).hostname}`);
    setStatus(saveStatus, "Saved. You can close this page.", "ok");
  } catch (error) {
    setConnectionBadge("disconnected", "Connection failed — check your URL and credentials.");
    setStatus(saveStatus, error.message, "error");
  } finally {
    saveBtn.disabled = false;
  }
});

// Allow Enter in password field to trigger save
extPasswordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveBtn.click();
});

init();
