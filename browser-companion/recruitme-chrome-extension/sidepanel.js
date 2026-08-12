/**
 * RecruitMe side panel — the conversation surface.
 *
 * A docked panel rather than a popup: a popup closes the instant focus moves,
 * and a hunt runs for minutes while the recruiter keeps using the tab it is
 * driving. The panel stays open beside the page it is working on.
 *
 * ESCAPING: every string rendered here — candidate names, headlines, the
 * agent's own summary of pages it read — ultimately originates on LinkedIn and
 * is attacker-controlled. Everything goes through textContent. Never introduce
 * innerHTML here.
 */

const $ = (id) => document.getElementById(id);

function api(path, opts) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "RECRUITME_API", path, opts }, (res) =>
      resolve(res || { ok: false, error: "The extension background worker did not respond." }),
    );
  });
}

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = String(text);
  return n;
}

function clear(n) {
  while (n && n.firstChild) n.removeChild(n.firstChild);
}

const thread = $("thread");
let renderedSteps = 0;
let traceEl = null;

function dropEmptyState() {
  const e = $("empty");
  if (e) e.remove();
}

function scrollDown() {
  thread.scrollTop = thread.scrollHeight;
}

function addUser(text) {
  dropEmptyState();
  const m = el("div", "msg user");
  m.appendChild(el("div", "bubble", text));
  thread.appendChild(m);
  scrollDown();
}

function startTrace() {
  renderedSteps = 0;
  traceEl = el("div", "trace");
  thread.appendChild(traceEl);
  const working = el("div", "working");
  working.appendChild(el("div", "spin"));
  working.appendChild(el("span", null, "Working…"));
  traceEl.appendChild(working);
  scrollDown();
}

/** Show each tool call as it happens, so the recruiter can watch it think. */
function renderTrace(snapshot) {
  if (!traceEl) startTrace();
  const steps = snapshot.trace || [];
  for (let i = renderedSteps; i < steps.length; i++) {
    const s = steps[i];
    const row = el("div", "step");
    row.appendChild(el("div", "dot"));
    const body = el("div");
    body.appendChild(el("span", "tool", s.tool));
    if (s.detail) body.appendChild(el("span", null, ` ${s.detail}`));
    row.appendChild(body);
    traceEl.insertBefore(row, traceEl.lastChild);
    renderedSteps++;
  }
  const working = traceEl.lastChild;
  if (working && working.className === "working") {
    const label = working.lastChild;
    if (label) label.textContent = snapshot.lastDetail || "Working…";
  }
  scrollDown();
}

function finishTrace(snapshot) {
  if (traceEl) {
    const working = traceEl.lastChild;
    if (working && working.className === "working") working.remove();
    if (!traceEl.childNodes.length) traceEl.remove();
    traceEl = null;
  }
  for (const w of snapshot.warnings || []) {
    thread.appendChild(el("div", "banner warn", w));
  }
  if (snapshot.halted) {
    thread.appendChild(el("div", "banner bad", `Stopped: ${snapshot.halted}`));
  }
  if (snapshot.answer) {
    const m = el("div", "msg agent");
    m.appendChild(el("div", "bubble", snapshot.answer));
    thread.appendChild(m);
  }
  scrollDown();
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

async function loadJobs() {
  // NOTE: /api/extension/jobs, NOT /api/jobs. The latter authenticates by
  // session cookie and sends no extension CORS headers, so from here it is
  // always a 401 — which is exactly why the picker said "No jobs found".
  const res = await api("/api/extension/jobs");
  const sel = $("job");
  clear(sel);
  if (!res.ok) {
    sel.appendChild(el("option", null, "Couldn't load jobs"));
    thread.appendChild(
      el("div", "banner bad", `Couldn't load your jobs: ${res.error || "unknown error"}. Check the extension's server URL and API key in Options.`),
    );
    return;
  }
  const jobs = Array.isArray(res.data) ? res.data : [];
  if (!jobs.length) {
    sel.appendChild(el("option", null, "No active jobs"));
    return;
  }
  for (const j of jobs) {
    const o = el("option", null, j.company ? `${j.title} — ${j.company}` : j.title);
    o.value = j.id;
    sel.appendChild(o);
  }
  const { lastJobId } = await chrome.storage.local.get("lastJobId");
  if (lastJobId && jobs.some((j) => j.id === lastJobId)) sel.value = lastJobId;
}

$("job").addEventListener("change", (e) => chrome.storage.local.set({ lastJobId: e.target.value }));

// ── Ask ──────────────────────────────────────────────────────────────────────

function setRunning(running) {
  $("send").disabled = running;
  $("stop").hidden = !running;
  $("ask").disabled = running;
}

function send() {
  const instruction = $("ask").value.trim();
  if (!instruction) return;
  addUser(instruction);
  $("ask").value = "";
  setRunning(true);
  startTrace();
  chrome.runtime.sendMessage(
    { type: "RECRUITME_AGENT_RUN", jobId: $("job").value || undefined, instruction },
    (res) => {
      if (res && res.ok === false) {
        finishTrace({ warnings: [], halted: res.error || "The agent could not start." });
        setRunning(false);
      }
    },
  );
}

$("send").addEventListener("click", send);
$("stop").addEventListener("click", () => chrome.runtime.sendMessage({ type: "RECRUITME_AGENT_ABORT" }));
$("ask").addEventListener("keydown", (e) => {
  // Enter sends; Shift+Enter is a newline — the convention everywhere else.
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
for (const b of document.querySelectorAll(".suggest")) {
  b.addEventListener("click", () => {
    $("ask").value = b.dataset.fill;
    $("ask").focus();
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "RECRUITME_AGENT_PROGRESS") return;
  const s = message.snapshot || {};
  $("hint").textContent = s.running ? `step ${s.steps}/${s.maxSteps}` : "";
  if (s.running) {
    renderTrace(s);
  } else {
    finishTrace(s);
    setRunning(false);
  }
});

// Re-opening the panel mid-run must show live state, not a blank thread.
chrome.runtime.sendMessage({ type: "RECRUITME_AGENT_STATE" }, (s) => {
  if (s && s.running) {
    dropEmptyState();
    setRunning(true);
    startTrace();
    renderTrace(s);
  }
});

void loadJobs();
