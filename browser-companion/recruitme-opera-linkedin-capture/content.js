const OBSERVE_INTERVAL_MS = 2500;

let lastObservedUrl = "";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLinkedInProfilePage() {
  return /linkedin\.com\/in\//i.test(location.href);
}

function cleanText(value) {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isVisible(element) {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function shouldExpand(element) {
  const label = (
    element.innerText ||
    element.getAttribute("aria-label") ||
    element.getAttribute("title") ||
    ""
  ).trim();

  if (!label) return false;
  if (/connect|message|follow|save to|send inmail|more filters|people also viewed/i.test(label)) return false;

  return /see more|show more|more\b/i.test(label);
}

async function waitForMain() {
  for (let i = 0; i < 30; i += 1) {
    const main = document.querySelector("main");
    if (main && cleanText(main.innerText || "").length > 120) return main;
    await sleep(400);
  }
  throw new Error("LinkedIn profile content did not finish loading");
}

async function expandInlineSections() {
  const clicked = new Set();

  for (let pass = 0; pass < 6; pass += 1) {
    let clickedThisPass = 0;
    const controls = Array.from(document.querySelectorAll("main button, main [role='button']"));
    for (const control of controls) {
      if (!(control instanceof HTMLElement)) continue;
      if (!isVisible(control) || !shouldExpand(control)) continue;

      const key = `${control.innerText}:${control.getAttribute("aria-label") || ""}`;
      if (clicked.has(key)) continue;

      clicked.add(key);
      control.click();
      clickedThisPass += 1;
      await sleep(120);
    }

    if (!clickedThisPass) break;
    await sleep(400);
  }
}

async function scrollProfile() {
  let previousHeight = 0;

  for (let i = 0; i < 20; i += 1) {
    window.scrollTo({ top: document.body.scrollHeight, behavior: "auto" });
    await sleep(450);
    await expandInlineSections();

    const nextHeight = document.body.scrollHeight;
    if (Math.abs(nextHeight - previousHeight) < 80) break;
    previousHeight = nextHeight;
  }

  window.scrollTo({ top: 0, behavior: "auto" });
  await sleep(150);
}

async function captureProfile() {
  const main = await waitForMain();
  await sleep(700);
  await expandInlineSections();
  await scrollProfile();
  await expandInlineSections();

  const mainText = cleanText(main.innerText || "");
  const dialogText = cleanText(
    Array.from(document.querySelectorAll("[role='dialog']"))
      .map((node) => node.innerText || "")
      .join("\n\n")
  );
  const profileText = cleanText([mainText, dialogText].filter(Boolean).join("\n\n")).slice(0, 100000);

  if (profileText.length < 200) {
    throw new Error("Captured profile text was too short");
  }

  return {
    linkedinUrl: location.href.replace(/[?#].*$/, ""),
    profileText,
    capturedAt: new Date().toISOString(),
    title: document.title,
  };
}

function notifyBackground() {
  if (!isLinkedInProfilePage()) return;

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

