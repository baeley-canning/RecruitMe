import { describe, it, expect } from "vitest";
import { buildBlankTabAdapter } from "../fetch-profile-orchestrator";

// Tests exercise the SAME builder the page uses (see page.tsx Fetch flow), so
// a refactor that swaps `location.href = url` for `location.assign(url)` etc.
// shows up here immediately rather than silently regressing.

describe("about:blank tab adapter (page.tsx setUrl)", () => {
  it("severs window.opener BEFORE setting location.href", () => {
    const events: string[] = [];
    let storedHref = "about:blank";

    // Build the win object with a getter/setter pair on location.href so we
    // can observe the order of opener vs. href assignment.
    const win = { opener: { sentinel: "still-here" } as unknown } as {
      opener: unknown;
      location: { href: string };
    };
    Object.defineProperty(win, "location", {
      value: Object.defineProperty({}, "href", {
        get: () => storedHref,
        set: (value: string) => {
          events.push(`href=${value} | opener=${win.opener === null ? "null" : "present"}`);
          storedHref = value;
        },
      }),
    });

    const adapter = buildBlankTabAdapter(Object.assign(win, { close: () => {} }));
    adapter.setUrl("https://www.linkedin.com/in/alex/");

    // opener must be null by the time location.href is set.
    expect(events).toEqual(["href=https://www.linkedin.com/in/alex/ | opener=null"]);
    expect(win.opener).toBeNull();
    expect(win.location.href).toBe("https://www.linkedin.com/in/alex/");
  });

  it("still navigates when opener is read-only (e.g. cross-origin policy)", () => {
    const win = {
      get opener() { return null; },
      set opener(_v: unknown) { throw new TypeError("Cannot assign to opener"); },
      location: { href: "about:blank" },
      close: () => {},
    } as unknown as { opener: unknown; location: { href: string }; close: () => void };

    const adapter = buildBlankTabAdapter(win);
    expect(() => adapter.setUrl("https://www.linkedin.com/in/alex/")).not.toThrow();
    expect(win.location.href).toBe("https://www.linkedin.com/in/alex/");
  });
});
