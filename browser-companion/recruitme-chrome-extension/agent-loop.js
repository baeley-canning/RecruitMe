/**
 * The agent loop — DeepSeek decides, the browser performs.
 *
 * Standalone: no RecruitMe app, no login, no proxy. Your own DeepSeek key is in
 * extension storage and the calls go straight to api.deepseek.com.
 *
 * This module deliberately contains NO judgement about candidates. It performs
 * whatever tool the model asked for and hands the result back. What it DOES own
 * is the safety envelope, because the cost of a runaway here is the recruiter's
 * own LinkedIn account: a loop running ~6x faster than intended got one flagged
 * on 2026-08-12. So the loop is bounded (40 steps), paced (3s minimum between
 * actions, measured from the START of the previous one), never retries, and
 * halts hard on any auth wall.
 *
 * Page text is fenced as untrusted data before the model ever sees it — see
 * deepseek.js for why that fence is the whole defence.
 */
import { chatTurn, fenceUntrusted, SYSTEM_PROMPT } from "./deepseek.js";

// Budget ACTUAL BROWSER ACTIONS, not model turns. The previous ceiling counted
// turns, and one turn can carry several tool calls — so a "40 step" run
// performed well over a hundred searches and profile reads before dying with
// nothing to show. Bound the thing that actually costs time and account risk.
const MAX_TOOL_CALLS = 55;
// When this many remain, tell the model to stop searching and write up.
const WRAP_UP_AT = 12;
const MIN_TOOL_GAP_MS = 3000;
const AUTH_WALL_RE = /\/(checkpoint|authwall|uas\/login|login)(\?|\/|$)/i;
const MAX_PAGE_CHARS = 12000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a));

/**
 * @param {{getApiKey:()=>Promise<string>, onProgress:Function, tabs:object, now:()=>number}} deps
 */
export function createAgentLoop({ getApiKey, onProgress, tabs, now }) {
  let state = freshState();
  let tabId = null;
  let aborted = false;
  let lastActionAt = 0;

  function freshState() {
    return {
      running: false,
      steps: 0,
      maxSteps: MAX_TOOL_CALLS,
      lastDetail: "",
      trace: [],
      answer: "",
      halted: null,
      warnings: [],
    };
  }

  const emit = () => onProgress({ ...state, trace: [...state.trace] });

  function detail(text) {
    state.lastDetail = text;
    if (state.trace.length) state.trace[state.trace.length - 1].detail = text;
    emit();
  }

  function warn(text) {
    state.warnings.push(text);
    emit();
  }

  function halt(reason) {
    state.halted = reason;
    state.running = false;
    emit();
  }

  async function pace() {
    const wait = lastActionAt + MIN_TOOL_GAP_MS - now();
    if (wait > 0) await sleep(wait);
    lastActionAt = now();
  }

  async function ensureTab() {
    if (tabId !== null) {
      try {
        await tabs.get(tabId);
        return tabId;
      } catch {
        tabId = null; // the human closed it
      }
    }
    // Background so it never steals focus while the recruiter works.
    const tab = await tabs.create({ url: "https://www.linkedin.com/feed/", active: false });
    tabId = tab.id;
    await sleep(2500);
    return tabId;
  }

  async function navigate(url) {
    const id = await ensureTab();
    await tabs.update(id, { url, active: false });
    // Poll for completion rather than trusting a fixed delay.
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const t = await tabs.get(id).catch(() => null);
      if (t && t.status === "complete") break;
    }
    const t = await tabs.get(id).catch(() => null);
    return t?.url || url;
  }

  function ask(id, message) {
    return new Promise((resolve) => {
      tabs.sendMessage(id, message, (res) => {
        void chrome.runtime.lastError;
        resolve(res || { ok: false, error: "The page did not respond — is it a LinkedIn tab?" });
      });
    });
  }

  async function readPage() {
    const id = await ensureTab();
    const res = await ask(id, { type: "RECRUITME_PAGE_TEXT" });
    if (!res.ok) return `Could not read the page: ${res.error || "unknown error"}`;
    if (AUTH_WALL_RE.test(res.url || "")) {
      halt("LinkedIn showed a login or security check. Solve it in the tab, then try again.");
      return null;
    }
    const text = String(res.text || "").slice(0, MAX_PAGE_CHARS);
    return fenceUntrusted(text || "(the page had no readable text)");
  }

  /** Perform one tool call. Returns the string result, or null if we halted. */
  async function runTool(call) {
    state.trace.push({ tool: call.name, detail: "" });
    emit();
    await pace();

    try {
      if (call.name === "search_linkedin") {
        const kw = String(call.args.keywords || "").trim();
        if (!kw) return "No keywords were given.";
        detail(kw);
        const landed = await navigate(
          `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(kw)}`,
        );
        if (AUTH_WALL_RE.test(landed)) {
          halt("LinkedIn showed a login or security check. Solve it in the tab, then try again.");
          return null;
        }
        await sleep(rand(1500, 3000));
        return await readPage();
      }

      if (call.name === "set_location_filter") {
        // Drive LinkedIn's OWN Locations filter rather than inventing our own.
        // Putting the place name in the keywords searches for the WORD, which
        // is not the same thing at all. LinkedIn also REMEMBERS this filter
        // between searches — which is how a Wellington role came back full of
        // Barcelona people — so once it is set correctly that stickiness works
        // in our favour for every subsequent search.
        const loc = String(call.args.location || "").trim();
        if (!loc) return "No location was given.";
        detail(loc);
        const id = await ensureTab();
        const res = await ask(id, { type: "RECRUITME_SET_LOCATION", location: loc });
        if (!res.ok) return `Could not set the Locations filter: ${res.error}`;
        await sleep(rand(1500, 2500));
        return `Locations filter set to "${res.applied}". It stays applied to later searches. ` +
          (await readPage());
      }

      if (call.name === "open_profile") {
        const url = String(call.args.url || "");
        if (!/^https:\/\/([a-z]+\.)?linkedin\.com\/in\//i.test(url)) {
          // Refuse anything that is not a profile. The URL came from page text,
          // which is attacker-controlled.
          return `Refused: "${url}" is not a linkedin.com/in/ profile URL.`;
        }
        detail(url.replace(/^https:\/\/(www\.)?/, ""));
        const landed = await navigate(url);
        if (AUTH_WALL_RE.test(landed)) {
          halt("LinkedIn showed a login or security check. Solve it in the tab, then try again.");
          return null;
        }
        await sleep(rand(3000, 5000)); // let the profile's lazy sections render
        return await readPage();
      }

      if (call.name === "get_page_text") {
        detail("current page");
        return await readPage();
      }

      if (call.name === "scroll_page") {
        detail("loading more");
        const id = await ensureTab();
        await ask(id, { type: "RECRUITME_SCROLL" });
        await sleep(1200);
        return await readPage();
      }

      return `Unknown tool: ${call.name}`;
    } catch (err) {
      // Never retry, never swallow — hand the failure back and let the model decide.
      return `The tool failed: ${err?.message || String(err)}`;
    }
  }

  return {
    getState: () => ({ ...state, trace: [...state.trace] }),

    abort() {
      aborted = true;
      halt("Stopped at your request.");
    },

    /** Run until the model answers, the step ceiling is hit, or we halt. */
    async run({ instruction }) {
      if (state.running) throw new Error("A hunt is already running.");
      const apiKey = await getApiKey();
      if (!apiKey) throw new Error("No DeepSeek API key saved — open the extension's Options and paste one.");

      state = freshState();
      state.running = true;
      aborted = false;
      lastActionAt = 0;
      emit();

      const messages = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: instruction },
      ];

      try {
        let wrapUpSent = false;

        while (state.running && !aborted && state.steps < MAX_TOOL_CALLS) {
          state.lastDetail = "Thinking…";
          emit();

          const turn = await chatTurn({ apiKey, messages });

          if (turn.type === "answer") {
            state.answer = turn.text;
            state.running = false;
            emit();
            break;
          }

          messages.push(turn.raw);
          for (const call of turn.calls) {
            if (aborted || state.steps >= MAX_TOOL_CALLS) break;
            state.steps += 1;
            const result = await runTool(call);
            if (result === null) return this.getState(); // halted
            messages.push({ role: "tool", tool_call_id: call.id, content: result });
          }

          // One nudge as the budget runs down, so it converges instead of
          // being cut off mid-search with nothing written.
          const left = MAX_TOOL_CALLS - state.steps;
          if (!wrapUpSent && left <= WRAP_UP_AT && state.running) {
            wrapUpSent = true;
            messages.push({
              role: "user",
              content:
                `You have about ${left} browser actions left. Stop searching now. Read at most a ` +
                `couple more profiles if you truly need them, then write your final answer with ` +
                `what you have.`,
            });
          }
        }

        // NEVER end with nothing. If the budget ran out mid-hunt, ask for the
        // write-up with tools disabled so it must answer in prose. All that
        // reading is otherwise thrown away — the same mistake as discarding a
        // partial harvest on timeout.
        if (state.running && !aborted && !state.answer) {
          state.lastDetail = "Out of actions — writing up what it found";
          emit();
          messages.push({
            role: "user",
            content:
              "You have run out of browser actions. Do not request any more. Write your final " +
              "answer now using only the profiles you already read: rank them, rate each out of " +
              "10, name the gaps, and say honestly how far you got and who you did not get to.",
          });
          const finalTurn = await chatTurn({ apiKey, messages, noTools: true }).catch(() => null);
          if (finalTurn?.type === "answer") {
            state.answer = finalTurn.text;
            warn(`Ran out of browser actions after ${state.steps} — this is what it had by then.`);
          } else {
            halt(`Reached the ${MAX_TOOL_CALLS}-action ceiling and could not produce a summary.`);
          }
          state.running = false;
          emit();
        }
      } catch (err) {
        halt(err?.message || String(err));
      } finally {
        state.running = false;
        if (tabId !== null) {
          await tabs.remove(tabId).catch(() => warn("Couldn't close the working tab."));
          tabId = null;
        }
        emit();
      }

      return this.getState();
    },
  };
}
