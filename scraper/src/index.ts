/**
 * RecruitMe Scraper Service
 *
 * A lightweight HTTP server that accepts scrape requests from the RecruitMe
 * app and returns LinkedIn profile text. Runs as a separate Railway service.
 *
 * Environment variables:
 *   PORT                  HTTP port (default 3001)
 *   SCRAPER_API_KEY       Shared secret — reject any request without this
 *   LINKEDIN_EMAIL        LinkedIn account email for login (optional if cookies set)
 *   LINKEDIN_PASSWORD     LinkedIn account password
 *   LINKEDIN_COOKIES      JSON-serialised cookie array (alternative to email/password)
 *
 * Endpoints:
 *   GET  /health          Liveness check
 *   POST /scrape          { url: string } → { profileText, capturedAt, profileUrl }
 *   POST /login           Trigger a fresh LinkedIn login (admin use)
 */

import http from "node:http";
import { scrapeProfile } from "./scrape.js";
import { loginLinkedIn, setSessionCookies } from "./browser.js";

const PORT  = Number(process.env.PORT ?? 3001);
const API_KEY = process.env.SCRAPER_API_KEY ?? "";

if (!API_KEY) {
  console.warn("[scraper] WARNING: SCRAPER_API_KEY is not set — all requests will be rejected");
}

// On startup, either load cookies from env or log in with email/password.
async function initSession(): Promise<void> {
  const cookieJson = process.env.LINKEDIN_COOKIES;
  if (cookieJson) {
    try {
      const cookies = JSON.parse(cookieJson);
      setSessionCookies(cookies);
      return;
    } catch {
      console.warn("[scraper] LINKEDIN_COOKIES was not valid JSON — ignoring");
    }
  }

  const email    = process.env.LINKEDIN_EMAIL;
  const password = process.env.LINKEDIN_PASSWORD;
  if (email && password) {
    console.log("[scraper] Logging into LinkedIn on startup…");
    await loginLinkedIn(email, password).catch((err) => {
      console.error("[scraper] Startup login failed:", err.message);
      console.error("[scraper] Scraper will start but scrapes will fail until a session is established");
    });
  } else {
    console.warn("[scraper] No LinkedIn credentials or cookies configured — set LINKEDIN_EMAIL + LINKEDIN_PASSWORD or LINKEDIN_COOKIES");
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  // Auth check on every non-health request
  if (req.url !== "/health") {
    const key = req.headers["x-scraper-api-key"] ?? "";
    if (!API_KEY || key !== API_KEY) {
      json(res, 401, { error: "Unauthorized" });
      return;
    }
  }

  if (req.method === "GET" && req.url === "/health") {
    json(res, 200, { ok: true, version: "1.0.0" });
    return;
  }

  if (req.method === "POST" && req.url === "/scrape") {
    let body: { url?: string };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { error: "Invalid JSON body" });
      return;
    }

    const url = body.url?.trim();
    if (!url || !url.includes("linkedin.com/in/")) {
      json(res, 400, { error: "url must be a linkedin.com/in/ profile URL" });
      return;
    }

    console.log(`[scraper] Scrape requested: ${url}`);
    const start = Date.now();
    try {
      const result = await scrapeProfile(url);
      console.log(`[scraper] Done in ${Date.now() - start}ms, ${result.profileText.length} chars`);
      json(res, 200, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[scraper] Failed in ${Date.now() - start}ms:`, msg);
      json(res, 500, { error: msg });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/login") {
    let body: { email?: string; password?: string };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { error: "Invalid JSON body" });
      return;
    }

    const email    = body.email?.trim();
    const password = body.password?.trim();
    if (!email || !password) {
      json(res, 400, { error: "email and password required" });
      return;
    }

    try {
      await loginLinkedIn(email, password);
      json(res, 200, { ok: true, message: "Login successful" });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  json(res, 404, { error: "Not found" });
});

server.listen(PORT, async () => {
  console.log(`[scraper] Server listening on port ${PORT}`);
  await initSession();
});

process.on("SIGTERM", () => {
  console.log("[scraper] SIGTERM received, shutting down");
  server.close(() => process.exit(0));
});
