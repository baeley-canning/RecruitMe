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


  // ── LinkedIn's own Locations filter ────────────────────────────────────────
  //
  // Use LinkedIn's mechanism, not a substitute. Putting a place name in the
  // keywords searches for the WORD; the Locations filter constrains the region.
  // LinkedIn remembers this filter between searches, which is how a Wellington
  // hunt came back full of Barcelona people — set it correctly once and that
  // stickiness works for us.
  //
  // The autocomplete option MUST be clicked. Pressing Enter can dismiss the
  // dropdown without applying anything, leaving a filter that looks set and is
  // not — a silent wrong-country search.

  const visible = (el) => el && el.offsetParent !== null;

  function findByText(selector, re) {
    return Array.from(document.querySelectorAll(selector)).find(
      (el) => visible(el) && re.test((el.innerText || el.textContent || "").trim()),
    );
  }

  async function until(fn, timeoutMs = 6000, everyMs = 150) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const v = fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, everyMs));
    }
    return null;
  }

  /** Type into a React-controlled input so its onChange actually fires. */
  function setNativeValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter ? setter.call(input, value) : (input.value = value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function setLocationFilter(location) {
    const chip =
      findByText('button', /^locations\b/i) ||
      document.querySelector('button[aria-label*="Locations" i]');
    if (!chip) return { ok: false, error: 'No "Locations" filter button on this page — is it a people-search results page?' };
    chip.click();

    const input = await until(() =>
      Array.from(document.querySelectorAll('input[type="text"], input[role="combobox"]')).find(
        (i) => visible(i) && /location|city|region|add a/i.test(i.getAttribute("placeholder") || i.getAttribute("aria-label") || ""),
      ),
    );
    if (!input) return { ok: false, error: "The Locations dropdown did not open." };

    input.focus();
    setNativeValue(input, location);

    // Wait for the typeahead, then CLICK an option. Never press Enter.
    const option = await until(() => {
      const opts = Array.from(document.querySelectorAll('[role="option"], li'))
        .filter((o) => visible(o) && (o.innerText || "").trim().length > 2);
      return (
        opts.find((o) => new RegExp(`^${location}\\b`, "i").test((o.innerText || "").trim())) ||
        opts.find((o) => (o.innerText || "").toLowerCase().includes(location.toLowerCase()))
      );
    }, 7000);
    if (!option) {
      return { ok: false, error: `No autocomplete match for "${location}". Try the region name LinkedIn uses, e.g. "Wellington, New Zealand".` };
    }
    const applied = (option.innerText || location).split("\n")[0].trim();
    option.click();

    // Apply. Some layouts apply on select; a "Show results" button appears in others.
    await new Promise((r) => setTimeout(r, 600));
    const show = findByText("button", /show results|apply/i);
    if (show) show.click();

    // Confirm it actually took, rather than trusting the clicks.
    const took = await until(
      () => /geoUrn|\bgeo\b/i.test(location && window.location.search) || null,
      4000,
    );
    return { ok: true, applied, url: window.location.href, confirmed: Boolean(took) };
  }


  // ── Structured profile read ────────────────────────────────────────────────
  //
  // Dumping 12,000 characters of flattened innerText per profile was costing
  // ~30k tokens a hunt and burying the actual evidence under boilerplate — the
  // About blurb, every bullet of every job, the full skills list. Worse, it
  // loses SECTION boundaries, so the model has to guess whether line 40 is
  // experience or education, which is exactly the guessing that produces a
  // confident wrong rating.
  //
  // Pull named sections instead. LinkedIn's class names are obfuscated and
  // churn, but its section ids (#experience, #education, #skills) and the
  // anchor/heading structure around them are comparatively stable.

  function sectionAfter(id) {
    const anchor = document.getElementById(id);
    if (!anchor) return "";
    // The anchor is an empty marker div; the content is in the enclosing
    // <section>, so climb to it and read from there.
    const section = anchor.closest("section") || anchor.parentElement;
    if (!section) return "";
    return (section.innerText || "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      // Drop LinkedIn's duplicated a11y text ("Company logo", "· 2nd").
      .filter((l) => !/^(company logo|logo|·|see more|show all|\d+ skills?)$/i.test(l))
      .join("\n");
  }

  function structuredProfile() {
    const topCard = document.querySelector("main section");
    const topLines = (topCard?.innerText || "")
      .split("\n").map((l) => l.trim()).filter(Boolean);
    return {
      url: location.href.split("?")[0],
      name: topLines[0] || document.title.replace(/\s*\|.*$/, "").trim(),
      headline: topLines[1] || "",
      location: topLines.find((l) => /,\s*(new zealand|nz|australia)/i.test(l)) || topLines[2] || "",
      about: sectionAfter("about").slice(0, 1200),
      experience: sectionAfter("experience").slice(0, 4000),
      education: sectionAfter("education").slice(0, 800),
      skills: sectionAfter("skills").slice(0, 600),
    };
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

    if (message?.type === "RECRUITME_PROFILE") {
      try {
        const p = structuredProfile();
        const usable = (p.experience || p.about || p.headline || "").length > 80;
        sendResponse({ ok: usable, profile: p, url: location.href, error: usable ? null : "profile sections did not render" });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
      return false;
    }

    if (message?.type === "RECRUITME_EXTRACT_CARDS") {
      // Uses the SAME parser as the box scraper (card-parse.js, 16 tests), so
      // the two can never disagree about what counts as a candidate. Zero cards
      // is an ERROR unless LinkedIn rendered its own no-results marker —
      // "our selectors broke" and "nobody matched" look identical otherwise.
      (async () => {
        try {
          const [{ parseCard }, { extractResultsPage }] = await Promise.all([
            import(chrome.runtime.getURL("card-parse.js")),
            import(chrome.runtime.getURL("results-extract.js")),
          ]);
          sendResponse(extractResultsPage(parseCard));
        } catch (err) {
          sendResponse({ ok: false, error: `Extractor failed to load: ${String(err?.message || err)}` });
        }
      })();
      return true;
    }

    if (message?.type === "RECRUITME_SET_LOCATION") {
      setLocationFilter(String(message.location || ""))
        .then((r) => sendResponse(r))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
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
