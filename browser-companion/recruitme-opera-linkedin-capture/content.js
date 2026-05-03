const OBSERVE_INTERVAL_MS = 2500;
const MIN_EXPANDED_PROFILE_TEXT_CHARS = 1100;

const SAFE_SECTION_HEADING_RE =
  /\b(about|experience|education|licenses|certifications|skills|top skills)\b/i;
const BLOCKED_SECTION_HEADING_RE =
  /\b(activity|posts|featured|recommendations|interests|people also viewed|more profiles for you|people you may know|pages for you|explore premium profiles|groups|services)\b/i;

const STOP_LINE_PATTERNS = [
  /^more profiles for you$/i,
  /^people you may know$/i,
  /^pages for you$/i,
  /^explore premium profiles$/i,
  /^linkedin corporation/i,
  /^recommendation transparency$/i,
  /^select language$/i,
  /^manage your account and privacy$/i,
  /^visit our help center\.$/i,
];

const NOISE_LINE_PATTERNS = [
  /^message$/i,
  /^follow$/i,
  /^connect$/i,
  /^contact info$/i,
  /^save in sales navigator$/i,
  /^activity$/i,
  /^open to$/i,
  /^more$/i,
  /^show all$/i,
  /^show all\s+[\u2192>]$/i,
  /^show all \d+ .+$/i,
  /^see all$/i,
  /^see all \d+ .+$/i,
  /^\u2026\s*more$/i,
  /^\.{3}\s*more$/i,
  /^[\u00b7\u2022]?\s*\d+(st|nd|rd|th)$/i,
  /^connections?$/i,
  /^followers$/i,
  /^\d+\+?\s+connections?$/i,
  /^\d+\+?\s+followers$/i,
  /^\d+\s+endorsements?$/i,
  /^.* has no recent posts$/i,
  /^recent posts .* displayed here\.$/i,
  /^from .* industry$/i,
];

const INTRO_NAME_SELECTORS = [
  "h1.text-heading-xlarge",
  "h1.inline.t-24.v-align-middle.break-words",
  "h1",
];

const INTRO_HEADLINE_SELECTORS = [
  ".pv-text-details__left-panel .text-body-medium",
  ".text-body-medium.break-words",
  ".pv-top-card .text-body-medium",
];

const INTRO_LOCATION_SELECTORS = [
  ".pv-text-details__left-panel .text-body-small.inline.t-black--light.break-words",
  ".pv-text-details__left-panel .text-body-small",
  ".text-body-small.inline.t-black--light.break-words",
  ".pv-top-card .text-body-small",
];

const SECTION_CONTAINER_SELECTOR =
  "section, div.artdeco-card, div.pvs-card, div[data-view-name], div[data-section]";

const PROFILE_SECTION_DEFINITIONS = [
  { key: "about", label: "About", ids: ["about", "summary"], headingRe: /^about$/i },
  { key: "experience", label: "Experience", ids: ["experience"], headingRe: /^experience$/i },
  { key: "education", label: "Education", ids: ["education"], headingRe: /^education$/i },
  { key: "skills", label: "Top skills", ids: ["skills"], headingRe: /^(skills|top skills)$/i },
  {
    key: "licenses_certifications",
    label: "Licenses & certifications",
    ids: ["licenses certifications", "licenses and certifications", "certifications"],
    headingRe: /licenses|certifications/i,
  },
];

const CORE_SECTION_KEYS = new Set(["about", "experience", "education", "skills", "licenses_certifications"]);

let lastObservedUrl = "";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLinkedInProfilePage() {
  return /linkedin\.com\/in\//i.test(location.href);
}

function isRootLinkedInProfile(url = "") {
  // Root profile only — excludes sub-pages like /details/experience
  return /linkedin\.com\/in\/[^/?#]+\/?([?#].*)?$/i.test(url);
}

function cleanText(value) {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeLineKey(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function normalizeSectionKey(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function splitIntoLines(value) {
  return cleanText(value)
    .split(/\n+/)
    .map((line) => cleanText(line))
    .filter(Boolean);
}

function isVisible(element) {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isNearViewport(element) {
  const rect = element.getBoundingClientRect();
  return rect.bottom >= -140 && rect.top <= window.innerHeight + 140;
}

function filterProfileLines(lines) {
  const filtered = [];
  const seen = new Set();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (STOP_LINE_PATTERNS.some((pattern) => pattern.test(line))) break;
    if (NOISE_LINE_PATTERNS.some((pattern) => pattern.test(line))) continue;
    if (/^\d+$/.test(line) && /^(connections?|followers)$/i.test(lines[i + 1] || "")) {
      i += 1;
      continue;
    }
    if (/^about accessibility talent solutions/i.test(line)) break;

    const key = normalizeLineKey(line);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    filtered.push(line);
  }

  return filtered;
}

function parentSectionHeading(element) {
  let node = element.parentElement;
  while (node && node !== document.body) {
    if (node.matches?.(SECTION_CONTAINER_SELECTOR)) {
      const heading = node.querySelector("h2, h3");
      const text = heading ? cleanText(heading.innerText || "") : "";
      if (text && (SAFE_SECTION_HEADING_RE.test(text) || BLOCKED_SECTION_HEADING_RE.test(text))) {
        return text;
      }
    }
    node = node.parentElement;
  }
  return "";
}

function matchesSafeInlineExpanderClass(element) {
  const className = typeof element.className === "string" ? element.className : "";
  return /inline-show-more-text__button|lt-line-clamp__more|see-more-less-toggle/i.test(className);
}

function shouldExpand(element) {
  if (element.tagName !== "BUTTON") return false;
  if (element.closest("a") || element.closest('[role="link"]')) return false;
  if (element.getAttribute("href")) return false;
  if (element.closest("nav, header, footer, aside, [role='dialog']")) return false;

  const label = cleanText(
    element.innerText ||
      element.getAttribute("aria-label") ||
      element.getAttribute("title") ||
      ""
  );
  if (!label) return false;
  if (!/^see more$|^show more$|^show \d+ more/i.test(label)) return false;

  const heading = parentSectionHeading(element);
  if (!heading || BLOCKED_SECTION_HEADING_RE.test(heading)) return false;

  if (matchesSafeInlineExpanderClass(element)) return SAFE_SECTION_HEADING_RE.test(heading);
  return SAFE_SECTION_HEADING_RE.test(heading);
}

async function waitForMain() {
  for (let i = 0; i < 30; i += 1) {
    const main = document.querySelector("main");
    if (main && cleanText(main.innerText || "").length > 120) return main;
    await sleep(400);
  }
  throw new Error("LinkedIn profile content did not finish loading");
}

async function expandInlineSections(clicked, options = {}) {
  const { visibleOnly = false, passes = 4 } = options;

  for (let pass = 0; pass < passes; pass += 1) {
    let clickedThisPass = 0;
    const controls = Array.from(document.querySelectorAll("main section button, main div.artdeco-card button"));

    for (const control of controls) {
      if (!(control instanceof HTMLElement)) continue;
      if (!isVisible(control) || (visibleOnly && !isNearViewport(control)) || !shouldExpand(control)) continue;

      const key = `${cleanText(control.innerText || "")}:${control.getAttribute("aria-label") || ""}:${parentSectionHeading(control)}`;
      if (clicked.has(key)) continue;

      clicked.add(key);
      control.click();
      clickedThisPass += 1;
      await sleep(180);

      if (!isLinkedInProfilePage()) {
        lastObservedUrl = "";
        history.back();
        await sleep(1500);
        return false;
      }
    }

    if (!clickedThisPass) break;
    await sleep(350);
  }

  return true;
}

async function scrollProfile(clicked) {
  const step = Math.max(Math.floor(window.innerHeight * 0.85), 520);
  let lastHeight = document.body.scrollHeight;
  let stableBottomPasses = 0;

  window.scrollTo({ top: 0, behavior: "auto" });
  await sleep(250);

  for (let pass = 0; pass < 26; pass += 1) {
    const nextTop = Math.min(
      Math.max(0, document.body.scrollHeight - window.innerHeight),
      pass === 0 ? 0 : window.scrollY + step
    );
    window.scrollTo({ top: nextTop, behavior: "auto" });
    await sleep(500);

    if (clicked) {
      const expanded = await expandInlineSections(clicked, { visibleOnly: true, passes: 1 });
      if (!expanded) return false;
    }

    await sleep(320);

    const nextHeight = document.body.scrollHeight;
    const atBottom = window.scrollY + window.innerHeight >= nextHeight - 60;
    if (Math.abs(nextHeight - lastHeight) < 80 && atBottom) {
      stableBottomPasses += 1;
      if (stableBottomPasses >= 2) break;
    } else {
      stableBottomPasses = 0;
    }
    lastHeight = nextHeight;
  }

  window.scrollTo({ top: 0, behavior: "auto" });
  await sleep(350);
  return true;
}

function verifyCaptureTarget(startUrl) {
  const endUrl = location.href.replace(/[?#].*$/, "");
  if (!isLinkedInProfilePage() || endUrl !== startUrl) {
    lastObservedUrl = "";
    throw new Error("Page navigated during capture - will retry automatically");
  }
}

function firstNonEmptyText(root, selectors) {
  for (const selector of selectors) {
    const element = root.querySelector(selector);
    if (!(element instanceof HTMLElement)) continue;
    const value = cleanText(element.innerText || element.textContent || "");
    if (value) return value;
  }
  return "";
}

function findIntroCard(main) {
  const nameEl = main.querySelector(INTRO_NAME_SELECTORS.join(", "));
  if (nameEl instanceof HTMLElement) {
    const card = nameEl.closest(SECTION_CONTAINER_SELECTOR);
    if (card instanceof HTMLElement) return card;
    if (nameEl.parentElement instanceof HTMLElement) return nameEl.parentElement;
  }

  const fallback = main.querySelector("section, div.artdeco-card");
  return fallback instanceof HTMLElement ? fallback : null;
}

function extractIntroText(main) {
  const introCard = findIntroCard(main);
  const introRoot = introCard || main;
  const name =
    firstNonEmptyText(introRoot, INTRO_NAME_SELECTORS) || firstNonEmptyText(main, INTRO_NAME_SELECTORS);
  const headline =
    firstNonEmptyText(introRoot, INTRO_HEADLINE_SELECTORS) ||
    firstNonEmptyText(main, INTRO_HEADLINE_SELECTORS);
  const location =
    firstNonEmptyText(introRoot, INTRO_LOCATION_SELECTORS) ||
    firstNonEmptyText(main, INTRO_LOCATION_SELECTORS);

  const lines = [];
  for (const value of [name, headline, location]) {
    if (value) lines.push(value);
  }

  if (introCard) {
    const introLines = filterProfileLines(splitIntoLines(introCard.innerText || ""));
    const seen = new Set(lines.map(normalizeLineKey));
    for (const line of introLines) {
      const key = normalizeLineKey(line);
      if (!key || seen.has(key)) continue;
      if (SAFE_SECTION_HEADING_RE.test(line) || BLOCKED_SECTION_HEADING_RE.test(line)) break;
      seen.add(key);
      lines.push(line);
      if (lines.length >= 8) break;
    }
  }

  return lines.join("\n");
}

function getSectionDefinitionForHeading(heading) {
  return PROFILE_SECTION_DEFINITIONS.find((definition) => definition.headingRe.test(heading)) || null;
}

function getSectionHeading(container) {
  const heading = cleanText(container.querySelector("h2, h3")?.innerText || "");
  if (heading) return heading;

  const idMatch = Array.from(container.querySelectorAll("[id]"))
    .map((element) => normalizeSectionKey(element.id))
    .find(Boolean);
  if (!idMatch) return "";

  return getSectionDefinitionForHeading(idMatch)?.label || "";
}

function findClosestSectionContainer(element) {
  const container = element.closest(SECTION_CONTAINER_SELECTOR);
  return container instanceof HTMLElement ? container : null;
}

function findSectionContainers(main, definition) {
  const containers = [];
  const seen = new Set();

  const addContainer = (element) => {
    const container = findClosestSectionContainer(element);
    if (!(container instanceof HTMLElement)) return;
    if (seen.has(container)) return;

    const heading = getSectionHeading(container);
    if (heading && BLOCKED_SECTION_HEADING_RE.test(heading)) return;

    seen.add(container);
    containers.push(container);
  };

  for (const heading of Array.from(main.querySelectorAll("h2, h3"))) {
    if (!(heading instanceof HTMLElement)) continue;
    const headingText = cleanText(heading.innerText || "");
    if (!definition.headingRe.test(headingText)) continue;
    addContainer(heading);
  }

  for (const anchor of Array.from(main.querySelectorAll("[id]"))) {
    if (!(anchor instanceof HTMLElement)) continue;
    const idKey = normalizeSectionKey(anchor.id);
    if (!definition.ids.includes(idKey)) continue;
    addContainer(anchor);
  }

  return containers;
}

function buildSectionText(container, definition) {
  const rawHeading = getSectionHeading(container) || definition.label;
  if (!rawHeading || BLOCKED_SECTION_HEADING_RE.test(rawHeading)) return "";

  const lines = filterProfileLines(splitIntoLines(container.innerText || ""));
  const removableKeys = new Set([normalizeSectionKey(rawHeading), ...definition.ids]);
  while (lines.length > 0 && removableKeys.has(normalizeSectionKey(lines[0]))) {
    lines.shift();
  }

  if (lines.length === 0) return "";
  return `${rawHeading}\n${lines.join("\n")}`;
}

function extractStructuredSections(main) {
  const parts = [];
  const sectionKeys = [];

  for (const definition of PROFILE_SECTION_DEFINITIONS) {
    let bestSectionText = "";

    for (const container of findSectionContainers(main, definition)) {
      const sectionText = buildSectionText(container, definition);
      if (sectionText.length > bestSectionText.length) {
        bestSectionText = sectionText;
      }
    }

    if (!bestSectionText) continue;
    sectionKeys.push(definition.key);
    parts.push(bestSectionText);
  }

  return { parts, sectionKeys };
}

function extractVisibleMainProfileText(main) {
  const lines = filterProfileLines(splitIntoLines(main.innerText || ""));
  if (lines.length === 0) return "";

  const useful = [];
  for (const line of lines) {
    if (/^search$/i.test(line)) continue;
    if (/^home$/i.test(line)) continue;
    if (/^my network$/i.test(line)) continue;
    if (/^jobs$/i.test(line)) continue;
    if (/^messaging$/i.test(line)) continue;
    if (/^notifications$/i.test(line)) continue;
    useful.push(line);
  }

  return cleanText(useful.join("\n"));
}

function mergeCaptureText(primaryText, fallbackText) {
  if (!fallbackText || fallbackText.length <= primaryText.length + 80) return primaryText;

  const primaryKeys = new Set(splitIntoLines(primaryText).map(normalizeLineKey).filter(Boolean));
  const additionalLines = splitIntoLines(fallbackText).filter((line) => {
    const key = normalizeLineKey(line);
    return key && !primaryKeys.has(key);
  });

  if (additionalLines.length === 0) return primaryText;
  return cleanText([primaryText, "Visible LinkedIn profile text", ...additionalLines].filter(Boolean).join("\n"));
}

function collectProfileText(startUrl, options = {}) {
  const { allowShort = false } = options;
  verifyCaptureTarget(startUrl);

  const main = document.querySelector("main");
  if (!(main instanceof HTMLElement)) {
    throw new Error("LinkedIn profile content did not finish loading");
  }

  const intro = extractIntroText(main);
  const { parts: sections, sectionKeys } = extractStructuredSections(main);
  const structuredText = cleanText([intro, ...sections].filter(Boolean).join("\n\n"));
  const fallbackText = extractVisibleMainProfileText(main);
  const profileText = mergeCaptureText(structuredText, fallbackText).slice(0, 100000);

  if (!allowShort && profileText.length < 200) {
    throw new Error("Captured profile text was too short");
  }

  return {
    linkedinUrl: startUrl,
    profileText,
    sectionKeys,
    capturedAt: new Date().toISOString(),
    title: document.title,
  };
}

function needsDeeperCapture(capture) {
  const coreSectionCount = capture.sectionKeys.filter((key) => CORE_SECTION_KEYS.has(key)).length;
  const hasIntro = !!capture.profileText.split(/\n+/)[0] && !SAFE_SECTION_HEADING_RE.test(capture.profileText.split(/\n+/)[0]);
  const hasExperience = capture.sectionKeys.includes("experience");
  const hasEducation = capture.sectionKeys.includes("education");

  return (
    capture.profileText.length < MIN_EXPANDED_PROFILE_TEXT_CHARS ||
    !hasIntro ||
    coreSectionCount < 3 ||
    (!hasExperience && !hasEducation)
  );
}

function buildExperienceDetailsUrl(profileBaseUrl) {
  try {
    const url = new URL(profileBaseUrl);
    const match = url.pathname.match(/^(\/in\/[^/]+)\/?/i);
    if (!match) return "";
    url.pathname = `${match[1]}/details/experience/`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function extractLinesFromDetachedDocument(doc) {
  const root = doc.querySelector("main") || doc.body;
  if (!root) return [];

  const selectors = [
    "main h1",
    "main h2",
    "main h3",
    "main li",
    "main p",
    "main span[aria-hidden='true']",
    "main span.visually-hidden",
    "main div[aria-label]",
  ];
  const raw = [];

  for (const element of Array.from(root.querySelectorAll(selectors.join(", ")))) {
    const value = cleanText(
      element.getAttribute?.("aria-label") ||
        element.textContent ||
        ""
    );
    if (value) raw.push(value);
  }

  if (raw.length === 0) {
    raw.push(cleanText(root.textContent || ""));
  }

  return filterProfileLines(raw.flatMap(splitIntoLines));
}

async function fetchExperienceDetailsText(profileBaseUrl) {
  const detailsUrl = buildExperienceDetailsUrl(profileBaseUrl);
  if (!detailsUrl) return "";

  try {
    const response = await fetch(detailsUrl, {
      credentials: "include",
      cache: "no-store",
      redirect: "follow",
    });
    if (!response.ok) return "";

    const html = await response.text();
    if (!/\/details\/experience|Experience/i.test(html)) return "";

    const doc = new DOMParser().parseFromString(html, "text/html");
    const lines = extractLinesFromDetachedDocument(doc);
    while (lines.length > 0 && /^experience$/i.test(lines[0])) lines.shift();

    const useful = [];
    const seen = new Set();
    for (const line of lines) {
      if (/^(experience|profile|linkedin|search)$/i.test(line)) continue;
      if (/^skip to main content$/i.test(line)) continue;
      const key = normalizeLineKey(line);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      useful.push(line);
    }

    if (useful.length < 3 || useful.join("\n").length < 160) return "";
    return `Experience\n${useful.join("\n")}`;
  } catch (error) {
    console.warn("[RecruitMe] failed to fetch full experience details:", error?.message || error);
    return "";
  }
}

function mergeExperienceSection(mainCapture, fullExperienceText) {
  if (!fullExperienceText || fullExperienceText.length < 160) return mainCapture;

  const profileText = mainCapture.profileText;
  const expIdx = profileText.search(/\nExperience\n/i);
  if (expIdx === -1) {
    return {
      ...mainCapture,
      profileText: cleanText(`${profileText}\n\n${fullExperienceText}`).slice(0, 100000),
      sectionKeys: [...new Set([...mainCapture.sectionKeys, "experience"])],
    };
  }

  const afterExp = profileText.slice(expIdx + 1);
  const nextMatch = afterExp.search(/\n(Education|Skills|Top skills|Licenses|Certifications)\n/i);

  const merged =
    nextMatch !== -1
      ? profileText.slice(0, expIdx + 1) + fullExperienceText + "\n\n" + profileText.slice(expIdx + 1 + nextMatch + 1)
      : profileText.slice(0, expIdx + 1) + fullExperienceText;

  return {
    ...mainCapture,
    profileText: cleanText(merged).slice(0, 100000),
    sectionKeys: [...new Set([...mainCapture.sectionKeys, "experience"])],
  };
}

async function enrichWithExperienceDetails(mainCapture, profileBaseUrl) {
  const fullExperienceText = await fetchExperienceDetailsText(profileBaseUrl);
  const enriched = mergeExperienceSection(mainCapture, fullExperienceText);
  if (enriched.profileText.length > mainCapture.profileText.length + 120) {
    console.log("[RecruitMe] merged full experience details", {
      before: mainCapture.profileText.length,
      after: enriched.profileText.length,
    });
  }
  return enriched;
}

async function waitForRootProfilePage(expectedUrl = "") {
  const expectedSlug = normaliseLinkedInSlug(expectedUrl);
  for (let i = 0; i < 60; i += 1) {
    await sleep(200);
    if (!isRootLinkedInProfile(location.href)) continue;
    if (!expectedSlug || normaliseLinkedInSlug(location.href) === expectedSlug) return true;
  }
  return false;
}

async function captureProfile() {
  const startUrl = location.href.replace(/[?#].*$/, "");
  if (!isLinkedInProfilePage()) {
    throw new Error("Not on a LinkedIn profile page");
  }

  await waitForMain();
  await sleep(700);

  const clicked = new Set();
  const expandedAtTop = await expandInlineSections(clicked, { visibleOnly: true, passes: 2 });
  if (!expandedAtTop) {
    throw new Error("Page navigated during capture - will retry automatically");
  }

  const scrolled = await scrollProfile(clicked);
  if (!scrolled) {
    throw new Error("Page navigated during capture - will retry automatically");
  }

  let capture = collectProfileText(startUrl, { allowShort: true });
  if (!needsDeeperCapture(capture)) {
    capture = await enrichWithExperienceDetails(capture, startUrl);
    if (capture.profileText.length < 200) {
      throw new Error("Captured profile text did not contain enough usable profile text");
    }
    return capture;
  }

  const expanded = await expandInlineSections(clicked, { visibleOnly: false, passes: 6 });
  if (!expanded) {
    throw new Error("Page navigated during capture - will retry automatically");
  }

  const rescrolled = await scrollProfile(clicked);
  if (!rescrolled) {
    throw new Error("Page navigated during capture - will retry automatically");
  }

  capture = collectProfileText(startUrl, { allowShort: true });
  if (!needsDeeperCapture(capture)) {
    capture = await enrichWithExperienceDetails(capture, startUrl);
    if (capture.profileText.length < 200) {
      throw new Error("Captured profile text did not contain enough usable profile text");
    }
    return capture;
  }

  await sleep(800);
  capture = collectProfileText(startUrl, { allowShort: true });
  capture = await enrichWithExperienceDetails(capture, startUrl);

  if (capture.profileText.length < 200) {
    await sleep(1200);
    const finalRescrolled = await scrollProfile(clicked);
    if (finalRescrolled) {
      capture = collectProfileText(startUrl, { allowShort: true });
      capture = await enrichWithExperienceDetails(capture, startUrl);
    }
  }
  if (capture.profileText.length < 200) {
    throw new Error("Captured profile text did not contain enough usable profile text");
  }
  return capture;
}

// Default server bases for content-script-side POSTs (no service worker involved).
const CONTENT_DEFAULT_BASES = [
  "https://recruitme-production-8cc6.up.railway.app",
  "https://recruitme.railway.app",
];

let captureInProgress = false;
let captureInProgressSessionId = "";

function normaliseLinkedInSlug(url = "") {
  const m = url.match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  return m ? m[1].toLowerCase() : "";
}

async function postJson(base, path, body) {
  const resp = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(data?.error || `Server error (${resp.status})`);
  }
}

async function tryPost(serverBase, path, body) {
  const bases = [...new Set([serverBase, ...CONTENT_DEFAULT_BASES].filter(Boolean))];
  let lastErr = new Error("Could not reach RecruitMe server");
  for (const base of bases) {
    try {
      await postJson(base, path, body);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function runCaptureAndPost(sessionId, serverBase, expectedUrl) {
  console.log("[RecruitMe] runCaptureAndPost start", { sessionId, expectedUrl, currentUrl: location.href });
  let captureTimer;
  try {
    if (!isRootLinkedInProfile(location.href)) {
      if (expectedUrl && normaliseLinkedInSlug(location.href) === normaliseLinkedInSlug(expectedUrl)) {
        location.assign(expectedUrl);
        const restored = await waitForRootProfilePage(expectedUrl);
        if (!restored) {
          throw new Error("LinkedIn profile did not return to the main profile page");
        }
      } else {
        throw new Error("LinkedIn profile was not on the main profile page");
      }
    }

    if (expectedUrl) {
      const currentSlug = normaliseLinkedInSlug(location.href);
      const expectedSlug = normaliseLinkedInSlug(expectedUrl);
      if (!currentSlug || currentSlug !== expectedSlug) {
        throw new Error(`LinkedIn URL mismatch (expected ${expectedSlug || "?"}, got ${currentSlug || "?"})`);
      }
    }

    const capture = await Promise.race([
      captureProfile(),
      new Promise((_, reject) => {
        captureTimer = setTimeout(
          () => reject(new Error("Profile capture timed out — reload the LinkedIn tab and try again")),
          70_000
        );
      }),
    ]);
    clearTimeout(captureTimer);

    console.log("[RecruitMe] capture done", { chars: capture.profileText.length, sections: capture.sectionKeys });
    await tryPost(serverBase, "/api/extension/fetch-session/complete", {
      sessionId,
      linkedinUrl: capture.linkedinUrl,
      profileText: capture.profileText,
    });
    chrome.runtime.sendMessage(
      { type: "capture-complete", sessionId, candidateName: capture.title || "" },
      () => void chrome.runtime.lastError
    );
  } catch (error) {
    clearTimeout(captureTimer);
    const msg = (error?.message || "Capture failed").slice(0, 500);
    console.warn("[RecruitMe] capture failed:", msg);
    await tryPost(serverBase, "/api/extension/fetch-session/error", {
      sessionId,
      error: msg,
    }).catch((postErr) => {
      console.warn("[RecruitMe] failed to post error to server:", postErr?.message || postErr);
    });
    chrome.runtime.sendMessage(
      { type: "capture-error", sessionId, error: msg },
      () => void chrome.runtime.lastError
    );
  } finally {
    captureInProgress = false;
    captureInProgressSessionId = "";
  }
}

function notifyBackground() {
  if (!isLinkedInProfilePage()) return;
  if (!isRootLinkedInProfile(location.href)) return; // Skip sub-pages like /details/experience

  const linkedinUrl = location.href.replace(/[?#].*$/, "");
  if (linkedinUrl === lastObservedUrl) return;
  lastObservedUrl = linkedinUrl;

  chrome.runtime.sendMessage(
    {
      type: "linkedin-page-observed",
      linkedinUrl,
      title: document.title,
    },
    () => {
      void chrome.runtime.lastError;
    }
  );
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Auto-capture: content script owns the full capture + POST so the
  // service worker doesn't need to stay alive for 30-60 seconds.
  if (message?.type === "capture-and-post") {
    if (captureInProgress) {
      if (captureInProgressSessionId && captureInProgressSessionId !== message.sessionId) {
        sendResponse({ ok: false, error: "Another RecruitMe capture is already running in this tab" });
        return false;
      }
      sendResponse({ ok: true, status: "in-progress" });
      return false;
    }
    captureInProgress = true;
    captureInProgressSessionId = message.sessionId || "";
    sendResponse({ ok: true, status: "started" });
    void runCaptureAndPost(message.sessionId, message.serverBase, message.linkedinUrl);
    return false;
  }

  // Manual capture (popup button): synchronous so popup gets real-time result.
  if (message?.type === "capture-profile") {
    void captureProfile()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "ping-profile") {
    sendResponse({
      ok: true,
      data: { linkedinUrl: location.href.replace(/[?#].*$/, ""), title: document.title },
    });
  }
});

notifyBackground();
setTimeout(notifyBackground, 1500);
setTimeout(notifyBackground, 4000);
setInterval(() => {
  if (!isLinkedInProfilePage()) return;
  const linkedinUrl = location.href.replace(/[?#].*$/, "");
  if (linkedinUrl !== lastObservedUrl) {
    notifyBackground();
  }
}, OBSERVE_INTERVAL_MS);
