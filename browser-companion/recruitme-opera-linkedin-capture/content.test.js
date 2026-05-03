import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import vm from "vm";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadContentScriptContext(overrides = {}) {
  const code = fs.readFileSync(path.join(__dirname, "content.js"), "utf8");
  const listeners = [];
  const context = {
    console,
    URL,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    location: { href: "https://example.com/" },
    document: { querySelector: () => null, body: null },
    window: {},
    chrome: {
      runtime: {
        lastError: null,
        sendMessage: () => {},
        onMessage: {
          addListener: (listener) => listeners.push(listener),
        },
      },
    },
    ...overrides,
  };

  vm.createContext(context);
  vm.runInContext(code, context);
  return { context, listeners };
}

describe("RecruitMe content script", () => {
  it("builds LinkedIn experience details URLs without preserving query strings", () => {
    const { context } = loadContentScriptContext();

    expect(
      context.buildExperienceDetailsUrl("https://www.linkedin.com/in/jane-candidate/?miniProfileUrn=abc#top")
    ).toBe("https://www.linkedin.com/in/jane-candidate/details/experience/");
  });

  it("replaces a short root Experience section with fetched full experience details", () => {
    const { context } = loadContentScriptContext();
    const capture = {
      profileText: "Jane Candidate\nEngineer\n\nExperience\nShort role\n\nEducation\nVictoria University",
      sectionKeys: ["experience", "education"],
    };
    const fullExperienceText = [
      "Experience",
      "Senior Engineer",
      "Acme",
      "Built hiring platforms, integrations, reporting workflows, and production data systems across a multi-year programme.",
      "Earlier Engineer",
      "Beta",
      "Owned API integrations, frontend delivery, search workflows, and internal automation for recruiting teams.",
    ].join("\n");

    const merged = context.mergeExperienceSection(capture, fullExperienceText);

    expect(merged.profileText).toContain("Earlier Engineer");
    expect(merged.profileText).not.toContain("Short role");
    expect(merged.profileText).toContain("Education\nVictoria University");
    expect(merged.sectionKeys).toContain("experience");
  });

  it("rejects a second capture session while the tab is already capturing", () => {
    const { listeners } = loadContentScriptContext({
      location: { href: "https://www.linkedin.com/in/jane-candidate/" },
    });
    const listener = listeners[0];
    const responses = [];

    listener(
      {
        type: "capture-and-post",
        sessionId: "session-1",
        linkedinUrl: "https://www.linkedin.com/in/jane-candidate/",
        serverBase: "https://recruitme-production-8cc6.up.railway.app",
      },
      {},
      (response) => responses.push(response)
    );
    listener(
      {
        type: "capture-and-post",
        sessionId: "session-2",
        linkedinUrl: "https://www.linkedin.com/in/jane-candidate/",
        serverBase: "https://recruitme-production-8cc6.up.railway.app",
      },
      {},
      (response) => responses.push(response)
    );

    expect(responses[0]).toEqual({ ok: true, status: "started" });
    expect(responses[1]).toEqual({
      ok: false,
      error: "Another RecruitMe capture is already running in this tab",
    });
  });
});
