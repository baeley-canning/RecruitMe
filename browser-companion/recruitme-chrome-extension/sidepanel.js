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

function startTrace() {
  finished = false;
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
