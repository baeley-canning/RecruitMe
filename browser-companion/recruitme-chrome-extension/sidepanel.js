/**
 * RecruitMe side panel — the conversation surface.
 *
 * You paste or attach a job description and say what you want. The extension is
 * STANDALONE — no RecruitMe login, no server, no mini-PC. Your own DeepSeek key
 * lives in this browser and the agent drives LinkedIn in your own session.
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

let workingLine = null;
let workingSince = 0;
let workingLabel = "";
let ticker = null;

function humanSecs(ms) {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, "0")}s`;
}

/**
 * Tick the elapsed time locally.
 *
 * The panel only updated when the runner emitted an event, and a model call can
 * run for a minute with nothing to emit — so it sat on "Thinking…" looking
 * hung. A local ticker proves it is alive and shows how long the current step
 * has actually taken.
 */
function startTicker() {
  stopTicker();
  ticker = setInterval(() => {
    if (!workingLine) return;
    workingLine.textContent = `${workingLabel} · ${humanSecs(Date.now() - workingSince)}`;
  }, 1000);
}

function stopTicker() {
  if (ticker) clearInterval(ticker);
  ticker = null;
}

function setWorking(label) {
  if (label !== workingLabel) {
    workingLabel = label;
    workingSince = Date.now();
  }
  if (workingLine) workingLine.textContent = `${workingLabel} · ${humanSecs(Date.now() - workingSince)}`;
}

function startTrace() {
  finished = false;
  renderedSteps = 0;
  traceEl = el("div", "trace");
  const working = el("div", "working");
  working.appendChild(el("div", "spin"));
  workingLine = el("span", null, "Starting…");
  working.appendChild(workingLine);
  traceEl.appendChild(working);
  thread.appendChild(traceEl);
  workingLabel = "";
  setWorking("Starting");
  startTicker();
  scrollDown();
}

function friendlyTool(t) {
  switch (t) {
    case "planning": return "Reading the job description";
    case "judging": return "Ranking what it read";
    case "set_location_filter": return "Setting the location filter";
    case "search_linkedin": return "Searching LinkedIn";
    case "open_profile": return "Reading profile";
    case "get_page_text": return "Reading page";
    case "scroll_page": return "Scrolling for more";
    case "check_library": return "Checking your library";
    default: return t || "Working";
  }
}

let finished = false;

function finishTrace(snapshot) {
  // The loop emits a final snapshot AND the run() promise resolves with one, so
  // this used to render "Stopped: ..." twice. Once per run is enough.
  if (finished) return;
  finished = true;
  stopTicker();
  workingLine = null;
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

/** Held open for the duration of a hunt — see the keep-alive note in background.js. */
let keepAlive = null;

function setRunning(running) {
  if (running && !keepAlive) {
    keepAlive = chrome.runtime.connect({ name: "recruitme-hunt" });
  } else if (!running && keepAlive) {
    keepAlive.disconnect();
    keepAlive = null;
  }
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
  const typed = $("ask").value.trim();
  // An attachment IS the job description — combine it with whatever was typed
  // so the model sees one instruction, with the document clearly delimited.
  const docs = attached
    .map((a) => `--- ${a.name} ---\n${a.text}`)
    .join("\n\n");
  const instruction = docs ? `${typed}\n\n${docs}`.trim() : typed;
  if (!instruction) return;
  addUser(typed || `Attached: ${attached.map((a) => a.name).join(", ")}`);
  $("ask").value = "";
  attached.length = 0;
  renderAttachments();
  autoGrow();
  setRunning(true);
  startTrace();
  // No jobId: the JD is in the instruction itself. The agent's library check
  // still works — without a job it reports membership rather than a fit score.
  chrome.runtime.sendMessage({ type: "RECRUITME_AGENT_RUN", instruction }, (res) => {
    // NEVER ignore a missing response. If the service worker crashed on load,
    // res is undefined and the old code did nothing — the panel just ticked
    // "Starting" forever with no clue why. Surface it.
    const err = chrome.runtime.lastError;
    if (err || !res) {
      finishTrace({
        warnings: [],
        halted:
          `The extension's background worker did not respond${err ? `: ${err.message}` : ""}. ` +
          `Open chrome://extensions, find RecruitMe, and click "Service worker" or "Errors" to see why.`,
      });
      setRunning(false);
      return;
    }
    if (res.ok === false) {
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
  if (s.running) {
    renderTrace(s);
    const bits = [];
    if (s.found) bits.push(`${s.found} found`);
    if (s.read) bits.push(`${s.read} read`);
    $("hint") && ($("hint").textContent = bits.join(" · "));
  }
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

// ── Attachments ──────────────────────────────────────────────────────────────
//
// A recruiter is usually holding the JD as a PDF, not as text they can paste.
// It is read entirely in this browser with a vendored pdf.js — the extension is
// standalone, so there is no server to post a file to and nothing is uploaded
// anywhere.

/** @type {{name: string, text: string}[]} */
const attached = [];

function renderAttachments() {
  const box = $("attachments");
  while (box.firstChild) box.removeChild(box.firstChild);
  attached.forEach((a, i) => {
    const chip = el("span", "chip");
    chip.appendChild(el("span", "nm", a.name));
    chip.appendChild(el("span", "sz", `${Math.round(a.text.length / 1000)}k chars`));
    const x = el("button", null, "×");
    x.title = "Remove";
    x.addEventListener("click", () => {
      attached.splice(i, 1);
      renderAttachments();
    });
    chip.appendChild(x);
    box.appendChild(chip);
  });
}

function showPending(name) {
  const box = $("attachments");
  const chip = el("span", "chip loading");
  chip.id = "pending-chip";
  chip.appendChild(el("span", "nm", name));
  chip.appendChild(el("span", "sz", "reading…"));
  box.appendChild(chip);
}

async function attachFile(file) {
  if (!file) return;
  showPending(file.name);
  try {
    // Read it HERE. The extension is standalone — there is no server to post a
    // file to, and nothing is uploaded anywhere.
    const { readDocument } = await import("./read-document.js");
    const doc = await readDocument(file);
    attached.push({ name: doc.name, text: doc.text });
    if (doc.truncated) {
      thread.appendChild(el("div", "banner warn", `${doc.name}: only the first 40,000 characters were used.`));
    }
  } catch (err) {
    thread.appendChild(el("div", "banner bad", `Couldn't read ${file.name}: ${err.message}`));
    scrollDown();
  } finally {
    const p = document.getElementById("pending-chip");
    if (p) p.remove();
    renderAttachments();
  }
}

$("attach").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", async (e) => {
  for (const f of Array.from(e.target.files || [])) await attachFile(f);
  e.target.value = ""; // let the same file be picked again
});

// Drag-and-drop onto the panel, and paste-a-file from the clipboard.
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  for (const f of Array.from(e.dataTransfer?.files || [])) await attachFile(f);
});
$("ask").addEventListener("paste", async (e) => {
  const files = Array.from(e.clipboardData?.files || []);
  if (!files.length) return;
  e.preventDefault();
  for (const f of files) await attachFile(f);
});


// ── Diagnose ─────────────────────────────────────────────────────────────────
// Proves card extraction, the Locations filter and the profile section reader
// against a live page. Free — no model calls — so run it whenever a hunt
// behaves oddly, and paste the report.

let diagBubble = null;

$("diagnose")?.addEventListener("click", () => {
  dropEmptyState();
  const m = el("div", "msg agent");
  diagBubble = el("div", "bubble", "Running diagnostic…");
  m.appendChild(diagBubble);
  thread.appendChild(m);
  scrollDown();
  $("diagnose").disabled = true;
  chrome.runtime.sendMessage({ type: "RECRUITME_DIAGNOSE" }, (res) => {
    $("diagnose").disabled = false;
    const err = chrome.runtime.lastError;
    if (err || !res) {
      diagBubble.textContent =
        `The extension's background worker did not respond${err ? `: ${err.message}` : ""}.\n` +
        `Open chrome://extensions -> RecruitMe -> "Service worker" / "Errors" and paste what it says.`;
      return;
    }
    if (res.ok === false) diagBubble.textContent = `Diagnostic failed: ${res.error}`;
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "RECRUITME_DIAGNOSE_PROGRESS") return;
  if (diagBubble) {
    diagBubble.textContent = message.text;
    scrollDown();
  }
});


// ── Worker health ────────────────────────────────────────────────────────────
// If the service worker failed to load, every button silently does nothing.
// Check once on open and say so plainly rather than letting the first hunt hang.
chrome.runtime.sendMessage({ type: "RECRUITME_PING" }, (res) => {
  const err = chrome.runtime.lastError;
  if (err || !res?.ok) {
    dropEmptyState();
    thread.appendChild(
      el(
        "div",
        "banner bad",
        `The extension's background worker isn't running${err ? ` (${err.message})` : ""}. ` +
          `Open chrome://extensions, find RecruitMe, and click "Service worker" or "Errors" — ` +
          `then send me what it says. Nothing will work until that loads.`,
      ),
    );
  }
});


// ── Copy report ──────────────────────────────────────────────────────────────
// Hands over everything the recorder captured — worker errors, every step,
// every failure, with timings. One click instead of hunting through a console.
// Profile body text is never recorded, only lengths, so this is safe to paste.
$("report")?.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "RECRUITME_REPORT" }, async (res) => {
    const err = chrome.runtime.lastError;
    const text =
      err || !res
        ? `Could not reach the background worker${err ? `: ${err.message}` : ""}.`
        : res.ok
          ? res.report
          : `Report failed: ${res.error}`;
    try {
      await navigator.clipboard.writeText(text);
      $("report").textContent = "Copied";
      setTimeout(() => ($("report").textContent = "Copy report"), 2000);
    } catch {
      // Clipboard can be refused; show it so it can be selected by hand.
      dropEmptyState();
      const m = el("div", "msg agent");
      m.appendChild(el("div", "bubble", text));
      thread.appendChild(m);
      scrollDown();
    }
  });
});

// The panel's own failures belong in the same report as the worker's.
window.addEventListener("error", (e) => {
  chrome.runtime.sendMessage({ type: "RECRUITME_PANEL_ERROR", detail: `${e.message} @ ${e.lineno}` });
});
window.addEventListener("unhandledrejection", (e) => {
  chrome.runtime.sendMessage({
    type: "RECRUITME_PANEL_ERROR",
    detail: String(e.reason?.stack || e.reason).split("\n").slice(0, 2).join(" | "),
  });
});
