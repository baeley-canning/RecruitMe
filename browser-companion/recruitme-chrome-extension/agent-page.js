/**
 * Page access for the agent, on any LinkedIn page.
 *
 * The model asks for page TEXT, never pixels — DeepSeek's API is text-only, and
 * text is far cheaper than screenshots anyway. This script answers two
 * questions from the background agent loop: "what does this page say" and
 * "scroll down so more of it loads".
 *
 * Classic script on purpose: MV3 content scripts are not modules, and a
 * top-level `export` is a syntax error that makes the whole file fail to load
 * with nothing in the page console to explain it.
 *
 * It never decides anything and never clicks anything a page told it to. The
 * text it returns is fenced as untrusted data by the caller before it reaches
 * the model.
 */
(() => {
  const MAX_CHARS = 12000;

  /** Strip the chrome that wastes tokens and says nothing about a candidate. */
  function readableText() {
    const drop = ["nav", "header", "footer", "script", "style", "noscript"];
    const clone = document.body ? document.body.cloneNode(true) : null;
    if (!clone) return "";
    for (const sel of drop) {
      for (const el of Array.from(clone.querySelectorAll(sel))) el.remove();
    }
    // Also drop LinkedIn's persistent global nav and messaging overlay.
    for (const sel of ['[role="banner"]', '[role="navigation"]', "#msg-overlay"]) {
      for (const el of Array.from(clone.querySelectorAll(sel))) el.remove();
    }
    return String(clone.innerText || "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join("\n");
  }

  function pageText() {
    const full = readableText();
    if (full.length <= MAX_CHARS) return { text: full, truncated: false };
    return {
      text: full.slice(0, MAX_CHARS),
      truncated: true,
    };
  }

  async function scrollDown() {
    const start = window.scrollY;
    const target = Math.min(start + window.innerHeight * 2, document.body.scrollHeight);
    // Stepped rather than instant: LinkedIn lazy-loads on scroll events, and a
    // single jump often loads nothing.
    for (let y = start; y < target; y += 400) {
      window.scrollTo({ top: y, behavior: "instant" });
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo({ top: target, behavior: "instant" });
    return { scrolledTo: target, pageHeight: document.body.scrollHeight };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "RECRUITME_PAGE_TEXT") {
      try {
        const { text, truncated } = pageText();
        sendResponse({ ok: true, text, truncated, url: location.href, title: document.title });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
      return false;
    }

    if (message?.type === "RECRUITME_SCROLL") {
      scrollDown()
        .then((info) => sendResponse({ ok: true, ...info }))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    }

    return undefined;
  });
})();
