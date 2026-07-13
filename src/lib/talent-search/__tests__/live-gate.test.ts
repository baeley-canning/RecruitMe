import { describe, it, expect } from "vitest";
import { shouldFireLive, liveHeldForLibrary, LIBRARY_SUFFICIENT_DEFAULT } from "@/lib/talent-search/live-gate";

const T = 25;

describe("shouldFireLive", () => {
  it("holds live back when the library is sufficient (>= threshold)", () => {
    expect(shouldFireLive({ libraryCount: 25, forceLive: false, wantLibrary: true, threshold: T })).toBe(false);
    expect(shouldFireLive({ libraryCount: 100, forceLive: false, wantLibrary: true, threshold: T })).toBe(false);
  });

  it("fires live when the library came up short (< threshold)", () => {
    expect(shouldFireLive({ libraryCount: 24, forceLive: false, wantLibrary: true, threshold: T })).toBe(true);
    expect(shouldFireLive({ libraryCount: 0, forceLive: false, wantLibrary: true, threshold: T })).toBe(true);
  });

  it("always fires when the user forces live, even with a full library", () => {
    expect(shouldFireLive({ libraryCount: 500, forceLive: true, wantLibrary: true, threshold: T })).toBe(true);
  });

  it("always fires when there is no library leg (live is the only source)", () => {
    expect(shouldFireLive({ libraryCount: 0, forceLive: false, wantLibrary: false, threshold: T })).toBe(true);
  });

  it("uses the default threshold when none is given", () => {
    expect(shouldFireLive({ libraryCount: LIBRARY_SUFFICIENT_DEFAULT - 1, forceLive: false, wantLibrary: true })).toBe(true);
    expect(shouldFireLive({ libraryCount: LIBRARY_SUFFICIENT_DEFAULT, forceLive: false, wantLibrary: true })).toBe(false);
  });
});

describe("liveHeldForLibrary", () => {
  it("is true only when a live source was requested AND it was held for sufficiency", () => {
    expect(liveHeldForLibrary({ libraryCount: 50, forceLive: false, wantLibrary: true, wantLiveSource: true, threshold: T })).toBe(true);
    // not requested → not held
    expect(liveHeldForLibrary({ libraryCount: 50, forceLive: false, wantLibrary: true, wantLiveSource: false, threshold: T })).toBe(false);
    // requested but library short → it fired, not held
    expect(liveHeldForLibrary({ libraryCount: 5, forceLive: false, wantLibrary: true, wantLiveSource: true, threshold: T })).toBe(false);
    // forced → fired, not held
    expect(liveHeldForLibrary({ libraryCount: 50, forceLive: true, wantLibrary: true, wantLiveSource: true, threshold: T })).toBe(false);
  });
});
