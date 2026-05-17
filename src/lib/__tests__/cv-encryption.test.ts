import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";

// Stub the prisma client used inside cv-encryption.ts — we don't want to
// reach a real DB and we want to drive Setting-row behaviour from the test.
const settingStore = new Map<string, { key: string; value: string }>();

const prismaMock = vi.hoisted(() => ({
  prisma: {
    setting: {
      findUnique: vi.fn(),
      create:     vi.fn(),
    },
    candidateFile: {
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("../db", () => prismaMock);

import {
  encryptCv,
  decryptCv,
  isEncrypted,
  maybeMigrateLegacy,
  _resetKeyCacheForTests,
} from "../cv-encryption";

function wireSettingStore() {
  prismaMock.prisma.setting.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => {
    return settingStore.get(where.key) ?? null;
  });
  prismaMock.prisma.setting.create.mockImplementation(async ({ data }: { data: { key: string; value: string } }) => {
    if (settingStore.has(data.key)) {
      const err = new Error("Unique constraint failed") as Error & { code?: string };
      err.code = "P2002";
      throw err;
    }
    settingStore.set(data.key, data);
    return data;
  });
}

describe("cv-encryption", () => {
  beforeEach(() => {
    settingStore.clear();
    _resetKeyCacheForTests();
    vi.clearAllMocks();
    wireSettingStore();
    // Provide a deterministic key via env so we don't depend on the
    // Setting-row bootstrap unless we explicitly want to test it.
    process.env.CV_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  });

  afterEach(() => {
    delete process.env.CV_ENCRYPTION_KEY;
    _resetKeyCacheForTests();
  });

  it("round-trips: encrypt → decrypt returns the original base64", async () => {
    const original = Buffer.from("hello world — a fake CV body").toString("base64");
    const cipher = await encryptCv(original);
    expect(cipher).not.toEqual(original);
    expect(cipher.startsWith("v1:")).toBe(true);
    const back = await decryptCv(cipher);
    expect(back).toBe(original);
  });

  it("legacy passthrough: decrypt on a non-prefixed string returns the input unchanged", async () => {
    const legacy = "SGVsbG8gd29ybGQ="; // not "v1:"-prefixed
    expect(isEncrypted(legacy)).toBe(false);
    const out = await decryptCv(legacy);
    expect(out).toBe(legacy);
  });

  it("decrypt throws on tampered ciphertext", async () => {
    const cipher = await encryptCv(Buffer.from("payload").toString("base64"));
    // Flip a byte inside the ciphertext segment — GCM auth tag should reject.
    const parts = cipher.split(":");
    const tampered = Buffer.from(parts[3], "base64");
    tampered[0] = tampered[0] ^ 0xff;
    parts[3] = tampered.toString("base64");
    await expect(decryptCv(parts.join(":"))).rejects.toThrow();
  });

  it("decrypt throws on a malformed envelope", async () => {
    await expect(decryptCv("v1:abc")).rejects.toThrow(/Malformed CV ciphertext/);
  });

  it("bootstraps a Setting row when no env var is configured", async () => {
    delete process.env.CV_ENCRYPTION_KEY;
    _resetKeyCacheForTests();

    const cipher = await encryptCv(Buffer.from("first upload").toString("base64"));
    expect(settingStore.has("cv.encryption.v1")).toBe(true);

    // Second call must use the same persisted key — round-trip proves it.
    _resetKeyCacheForTests();
    const back = await decryptCv(cipher);
    expect(back).toBe(Buffer.from("first upload").toString("base64"));
  });

  it("rejects environment keys that are not 32 bytes", async () => {
    process.env.CV_ENCRYPTION_KEY = Buffer.from("too-short").toString("base64");
    _resetKeyCacheForTests();
    await expect(
      encryptCv(Buffer.from("x").toString("base64")),
    ).rejects.toThrow(/32 bytes/);
  });

  it("maybeMigrateLegacy writes encrypted ciphertext back to the file row", async () => {
    const legacyBase64 = Buffer.from("legacy cv payload").toString("base64");
    await maybeMigrateLegacy("file-1", legacyBase64);
    expect(prismaMock.prisma.candidateFile.update).toHaveBeenCalledTimes(1);
    const call = prismaMock.prisma.candidateFile.update.mock.calls[0][0];
    expect(call.where.id).toBe("file-1");
    expect(call.data.data.startsWith("v1:")).toBe(true);
  });

  it("maybeMigrateLegacy throttles repeated migrations of the same file", async () => {
    const legacyBase64 = Buffer.from("hot file").toString("base64");
    await maybeMigrateLegacy("file-hot", legacyBase64);
    await maybeMigrateLegacy("file-hot", legacyBase64);
    await maybeMigrateLegacy("file-hot", legacyBase64);
    expect(prismaMock.prisma.candidateFile.update).toHaveBeenCalledTimes(1);
  });
});
