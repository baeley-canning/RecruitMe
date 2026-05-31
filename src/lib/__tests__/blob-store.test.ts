import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, createHmac } from "crypto";
import {
  _resetBlobConfigForTests,
  isBlobStoreConfigured,
  persistFileEnvelope,
  loadFileEnvelope,
  putBlob,
  getBlob,
} from "../blob-store";

const ENV_KEYS = [
  "BLOB_S3_ENDPOINT",
  "BLOB_S3_BUCKET",
  "BLOB_S3_ACCESS_KEY_ID",
  "BLOB_S3_SECRET_ACCESS_KEY",
  "BLOB_S3_REGION",
  "CV_ENCRYPTION_KEY",
] as const;

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

function configure() {
  process.env.BLOB_S3_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
  process.env.BLOB_S3_BUCKET = "recruitme-files";
  process.env.BLOB_S3_ACCESS_KEY_ID = "AKIAEXAMPLE";
  process.env.BLOB_S3_SECRET_ACCESS_KEY = "secretexamplekey";
  process.env.BLOB_S3_REGION = "auto";
  // Set so the configured-path tests don't trip the key-durability warning;
  // the warning has its own dedicated test that unsets it.
  process.env.CV_ENCRYPTION_KEY = "dGVzdC1rZXktMzItYnl0ZXMtZm9yLXVuaXQtdGVzdHM=";
}

beforeEach(() => {
  clearEnv();
  _resetBlobConfigForTests();
  vi.restoreAllMocks();
});

afterEach(() => {
  clearEnv();
  _resetBlobConfigForTests();
});

describe("inert until configured", () => {
  it("is not configured with no env", () => {
    expect(isBlobStoreConfigured()).toBe(false);
  });

  it("persistFileEnvelope stores inline (no network) when unconfigured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const out = await persistFileEnvelope("v1:abc:def:ghi");
    expect(out).toEqual({ data: "v1:abc:def:ghi", storageKey: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("loadFileEnvelope returns inline data when storageKey is null", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const env = await loadFileEnvelope({ data: "v1:inline", storageKey: null });
    expect(env).toBe("v1:inline");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("configured (S3/R2)", () => {
  beforeEach(() => {
    configure();
    _resetBlobConfigForTests();
  });

  it("reports configured", () => {
    expect(isBlobStoreConfigured()).toBe(true);
  });

  it("putBlob issues a SigV4-signed PUT with the body and content hash", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    await putBlob("candidate-files/abc123", "v1:payload");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://acct.r2.cloudflarestorage.com/recruitme-files/candidate-files/abc123",
    );
    expect(init.method).toBe("PUT");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
    // x-amz-content-sha256 must be the SHA-256 of the (utf8) body.
    expect(headers["x-amz-content-sha256"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("persistFileEnvelope uploads and returns a storageKey pointer", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const out = await persistFileEnvelope("v1:abc:def:ghi");
    expect(out.data).toBe("");
    expect(out.storageKey).toMatch(/^candidate-files\/[0-9a-f]{32}$/);
  });

  it("loadFileEnvelope GETs the object when storageKey is set", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("v1:fromR2", { status: 200 }));
    const env = await loadFileEnvelope({ data: "", storageKey: "candidate-files/xyz" });
    expect(env).toBe("v1:fromR2");
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("GET");
  });

  it("putBlob throws on a non-2xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("AccessDenied", { status: 403 }),
    );
    await expect(putBlob("candidate-files/x", "v1:p")).rejects.toThrow(/403/);
  });

  it("getBlob throws on 404", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
    await expect(getBlob("candidate-files/missing")).rejects.toThrow(/404/);
  });
});

describe("key-durability guard", () => {
  it("warns ONCE when offloading without an explicit CV_ENCRYPTION_KEY", async () => {
    configure();
    delete process.env.CV_ENCRYPTION_KEY; // key would live only in the DB Setting row
    _resetBlobConfigForTests();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await persistFileEnvelope("v1:a");
    await persistFileEnvelope("v1:b");

    expect(warn).toHaveBeenCalledTimes(1); // once per process, not per upload
    expect(warn.mock.calls[0][0]).toMatch(/CV_ENCRYPTION_KEY/);
  });

  it("does NOT warn when CV_ENCRYPTION_KEY is set", async () => {
    configure(); // sets CV_ENCRYPTION_KEY
    _resetBlobConfigForTests();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await persistFileEnvelope("v1:a");

    expect(warn).not.toHaveBeenCalled();
  });
});

describe("SigV4 known-answer (cross-checked against an independent signer)", () => {
  beforeEach(() => {
    configure();
    _resetBlobConfigForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("matches a SigV4 signature computed independently for the same fixed inputs", async () => {
    // Fix the clock so x-amz-date is deterministic, then capture what putBlob
    // actually signs and compare it to a signature derived here from scratch
    // (separate code following the SigV4 spec). Any divergence in canonical
    // request assembly, header order, payload hashing, scope, string-to-sign,
    // or the signing-key HMAC chain fails this test.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-31T09:15:00.000Z"));
    const body = "v1:iv:tag:ciphertext";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    await putBlob("candidate-files/abc123", body);

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const actualAuth = (init.headers as Record<string, string>).Authorization;

    // --- independent SigV4 recompute (AWS spec; mirrors nothing from the lib) ---
    const secret = "secretexamplekey";
    const accessKeyId = "AKIAEXAMPLE";
    const region = "auto";
    const host = "acct.r2.cloudflarestorage.com";
    const amzdate = "20260531T091500Z";
    const datestamp = "20260531";
    const hex = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
    const mac = (k: Buffer | string, d: string) => createHmac("sha256", k).update(d, "utf8").digest();

    const payloadHash = hex(Buffer.from(body, "utf8"));
    const canonicalUri = "/recruitme-files/candidate-files/abc123";
    const canonicalHeaders =
      `host:${host}\n` +
      `x-amz-content-sha256:${payloadHash}\n` +
      `x-amz-date:${amzdate}\n`;
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
    const canonicalRequest = ["PUT", canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const scope = `${datestamp}/${region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzdate, scope, hex(canonicalRequest)].join("\n");
    const kSigning = mac(mac(mac(mac(`AWS4${secret}`, datestamp), region), "s3"), "aws4_request");
    const expectedSig = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
    const expectedAuth =
      `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${expectedSig}`;

    expect(actualAuth).toBe(expectedAuth);
    // And the date header the lib emitted matches the fixed clock.
    expect((init.headers as Record<string, string>)["x-amz-date"]).toBe(amzdate);
  });
});
