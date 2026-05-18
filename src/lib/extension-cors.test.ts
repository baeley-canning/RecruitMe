import { afterEach, describe, expect, it, vi } from "vitest";
import { EXTENSION_CORS, extensionCorsHeaders } from "./extension-cors";

describe("extension CORS", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reflects only the configured Railway app origin", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://recruitme.railway.app");

    const allowed = extensionCorsHeaders(new Request("http://localhost/api/extension/jobs", {
      headers: { Origin: "https://recruitme.railway.app" },
    }));
    const otherTenant = extensionCorsHeaders(new Request("http://localhost/api/extension/jobs", {
      headers: { Origin: "https://attacker.up.railway.app" },
    }));

    expect(allowed["Access-Control-Allow-Origin"]).toBe("https://recruitme.railway.app");
    expect(otherTenant["Access-Control-Allow-Origin"]).toBe("null");
  });

  it("can pin packaged extension origins with EXTENSION_ALLOWED_ORIGINS", () => {
    vi.stubEnv("EXTENSION_ALLOWED_ORIGINS", "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

    const allowed = extensionCorsHeaders(new Request("http://localhost/api/extension/jobs", {
      headers: { Origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    }));
    const denied = extensionCorsHeaders(new Request("http://localhost/api/extension/jobs", {
      headers: { Origin: "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
    }));

    expect(allowed["Access-Control-Allow-Origin"]).toBe("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(denied["Access-Control-Allow-Origin"]).toBe("null");
  });

  it("allows PATCH in preflight methods", () => {
    expect(EXTENSION_CORS["Access-Control-Allow-Methods"]).toContain("PATCH");
    expect(extensionCorsHeaders(new Request("http://localhost"))["Access-Control-Allow-Methods"]).toContain("PATCH");
  });
});
