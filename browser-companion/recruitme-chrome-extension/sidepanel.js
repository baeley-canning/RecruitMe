/**
 * RecruitMe side panel — the conversation surface.
 *
 * You paste a job description and say what you want. There is deliberately NO
 * job picker: the recruiter is reading a JD somewhere else and pasting it, and
 * making them first create a matching job in RecruitMe put a form between them
 * and the thing they actually wanted.
 *
 * ESCAPING: every string rendered here — candidate names, headlines, the
 * agent's own summary of pages it read — ultimately originates on LinkedIn and
 * is attacker-controlled. Everything goes through textContent. Never introduce
 * innerHTML here.
 */

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = String(text);
  return n;
}

const thread = $("thread");
let renderedSteps = 0;
let traceEl = null;

function scrollDown() {
  thread.scrollTop = thread.scrollHeight;
}

function dropEmptyState() {
  const e = $("empty");
  if (e) e.remove();
}

function addUser(text) {
  dropEmptyState();
  const m = el("div", "msg user");
  // A pasted JD is long; show enough to identify the ask without burying the
  // conversation under a wall of someone else's text.
  const shown = text.length > 400 ? `${text.slice(0, 400)}…` : text;
  m.appendChild(el("div", "bubble", shown));
  thread.appendChild(m);
  scrollDown();
}

function startTrace() {
  renderedSteps = 0;
  traceEl = el("div", "trace");
  const working = el("div", "working");
  working.appendChild(el("div", "spin"));
  working.appendChild(el("span", null, "Thinking…"));
  traceEl.appendChild(working);
  thread.appendChild(traceEl);
  scrollDown();
}

/** Show each tool call as it happens, so you can watch it work. */
function renderTrace(snapshot) {
  if (!traceEl) startTrace();
  const steps = snapshot.trace || [];
  for (let i = renderedSteps; i < steps.length; i++) {
    const s = steps[i];
    const row = el("div", "step");
    row.appendChild(el("div", "dot"));
    const body = el("div");
    body.appendChild(el("span", "tool", friendlyTool(s.tool)));
    if (s.detail) body.appendChild(el("span", null, ` — ${s.detail}`));
    row.appendChild(body);
    traceEl.insertBefore(row, traceEl.lastChild);
    renderedSteps++;
  }
  const working = traceEl.lastChild;
  if (working && working.className === "working" && working.lastChild) {
    working.lastChild.textContent = snapshot.lastDetail || "Thinking…";
  }
  scrollDown();
}

function friendlyTool(t) {
  switch (t) {
    case "search_linkedin": return "Searching LinkedIn";
    case "open_profile": return "Reading profile";
    case "get_page_text": return "Reading page";
    case "scroll_page": return "Scrolling for more";
    case "check_library": return "Checking your library";
    default: return t || "Working";
  }
}

function finishTrace(snapshot) {
  if (traceEl) {
    const working = traceEl.lastChild;
    if (working && working.className === "working") working.remove();
    if (!traceEl.childNodes.length) traceEl.remove();
    traceEl = null;
  }
  for (const w of snapshot.warnings || []) thread.appendChild(el("div", "banner warn", w));
  if (snapshot.halted) thread.appendChild(el("div", "banner bad", `Stopped: ${snapshot.halted}`));
  if (snapshot.answer) {
    const m = el("div", "msg agent");
    m.appendChild(el("div", "bubble", snapshot.answer));
    thread.appendChild(m);
  }
  scrollDown();
}

// ── Sending ──────────────────────────────────────────────────────────────────

function setRunning(running) {
  $("send").disabled = running;
  $("stop").hidden = !running;
  $("ask").disabled = running;
}

function autoGrow() {
  const t = $("ask");
  t.style.height = "auto";
  t.style.height = `${Math.min(t.scrollHeight, 180)}px`;
}

function send() {
  const instruction = $("ask").value.trim();
  if (!instruction) return;
  addUser(instruction);
  $("ask").value = "";
  autoGrow();
  setRunning(true);
  startTrace();
  // No jobId: the JD is in the instruction itself. The agent's library check
  // still works — without a job it reports membership rather than a fit score.
  chrome.runtime.sendMessage({ type: "RECRUITME_AGENT_RUN", instruction }, (res) => {
    if (res && res.ok === false) {
      finishTrace({ warnings: [], halted: res.error || "The agent could not start." });
      setRunning(false);
    }
  });
}

$("send").addEventListener("click", send);
$("stop").addEventListener("click", () => chrome.runtime.sendMessage({ type: "RECRUITME_AGENT_ABORT" }));
$("ask").addEventListener("input", autoGrow);
$("ask").addEventListener("keydown", (e) => {
  // Enter sends, Shift+Enter is a newline — but a pasted JD is multi-line, so
  // Enter only sends when the field is a single line. Otherwise you would fire
  // the moment you pressed Enter partway through pasting.
  if (e.key === "Enter" && !e.shiftKey && !$("ask").value.includes("\n")) {
    e.preventDefault();
    send();
  }
});
for (const b of document.querySelectorAll(".suggest")) {
  b.addEventListener("click", () => {
    $("ask").value = b.dataset.fill;
    autoGrow();
    $("ask").focus();
    $("ask").setSelectionRange($("ask").value.length, $("ask").value.length);
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "RECRUITME_AGENT_PROGRESS") return;
  const s = message.snapshot || {};
  if (s.running) renderTrace(s);
  else {
    finishTrace(s);
    setRunning(false);
  }
});

// Re-opening the panel mid-run shows live state, not a blank thread.
chrome.runtime.sendMessage({ type: "RECRUITME_AGENT_STATE" }, (s) => {
  if (s && s.running) {
    dropEmptyState();
    setRunning(true);
    startTrace();
    renderTrace(s);
  }
});
