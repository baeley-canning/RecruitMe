#!/usr/bin/env node
/**
 * RecruitMe Box → seller candidate-pool sync (Phase J5).
 *
 * Gated by OPT_IN_CANDIDATE_POOL=true in /etc/recruitme/box.env.
 * Without the flag, this script exits silently — boxes ship with the
 * schema (CandidatePoolSync table) but the pipe stays dormant until
 * the customer's data-sharing T&Cs are signed and the flag is flipped.
 *
 * What gets uploaded (per row):
 *   - Canonical identity: linkedinUrl, jobAdderUrl, seekUrl, name, headline, location
 *   - Profile text (CV-derived; already sanitised at extract time)
 *   - Skills / employers / titles from CandidateInsights (if present)
 *   - source_box_id (so the pool can attribute provenance for revenue share)
 *
 * What does NOT get uploaded:
 *   - Per-customer notes, screening data, interview notes (those belong to
 *     the customer, not the pool)
 *   - Match scores against the customer's specific jobs
 *   - Contact events (who emailed who)
 *
 * Idempotency: each row hashes the canonical payload and writes to
 * CandidatePoolSync.uploadedHash. Re-runs skip rows where the hash hasn't
 * changed. A row that fails to upload retries on the next tick.
 */

import { PrismaClient } from "@prisma/client";
import { readFileSync, existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

function loadConfig() {
  const path = process.env.RECRUITME_BOX_CONFIG ?? "/etc/recruitme/box.env";
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const cfg = loadConfig();
const OPT_IN = cfg.OPT_IN_CANDIDATE_POOL === "true";
const POOL_URL = cfg.POOL_INGEST_URL ?? "";
const BOX_ID = cfg.BOX_ID;
const BOX_TOKEN = cfg.BOX_TOKEN;

if (!OPT_IN) {
  console.log("[pool-sync] OPT_IN_CANDIDATE_POOL not set — pipe dormant, exit");
  process.exit(0);
}

if (!POOL_URL || !BOX_ID || !BOX_TOKEN) {
  console.log("[pool-sync] opt-in flag is on but POOL_INGEST_URL / BOX_ID / BOX_TOKEN missing — refusing to upload partial config");
  process.exit(1);
}

const prisma = new PrismaClient();
const BATCH_SIZE = 100;
const MAX_TICKS = 1000; // safety

function canonicalPayload(c, insightFacts) {
  return {
    linkedinUrl: c.linkedinUrl ?? null,
    jobAdderUrl: c.jobAdderUrl ?? null,
    seekUrl: c.seekUrl ?? null,
    name: c.name,
    headline: c.headline ?? null,
    location: c.location ?? null,
    profileText: c.profileText ?? null,
    insight: insightFacts ? {
      currentTitle: insightFacts.currentTitle ?? null,
      primaryStack: insightFacts.primaryStack ?? [],
      secondaryStack: insightFacts.secondaryStack ?? [],
      domains: insightFacts.domains ?? [],
      titlesHeld: insightFacts.titlesHeld ?? [],
    } : null,
    source_box_id: BOX_ID,
  };
}

function hashPayload(p) {
  return createHash("sha256").update(JSON.stringify(p)).digest("hex");
}

async function syncBatch() {
  // Pick candidates that either (a) have never been synced, or (b) have
  // been updated since their last sync. Cap at BATCH_SIZE per tick so a
  // huge backlog doesn't lock the DB.
  const candidates = await prisma.candidate.findMany({
    where: {
      OR: [
        { poolSync: null },
        { updatedAt: { gt: prisma.candidatePoolSync.fields?.updatedAt ?? new Date(0) } },
      ],
    },
    select: {
      id: true,
      linkedinUrl: true,
      jobAdderUrl: true,
      seekUrl: true,
      name: true,
      headline: true,
      location: true,
      profileText: true,
      candidateIdentityId: true,
      poolSync: { select: { uploadedHash: true } },
    },
    take: BATCH_SIZE,
    orderBy: { updatedAt: "asc" },
  }).catch(() => []);

  if (candidates.length === 0) return 0;

  // Batch-fetch insights for the candidates that have them.
  const identityIds = candidates.map((c) => c.candidateIdentityId).filter(Boolean);
  const insights = identityIds.length > 0
    ? await prisma.profileInsight.findMany({
        where: { identityId: { in: identityIds }, supersededAt: null },
        select: { identityId: true, factsJson: true },
      }).catch(() => [])
    : [];
  const factsByIdentity = new Map(insights.map((i) => {
    try { return [i.identityId, JSON.parse(i.factsJson)]; } catch { return [i.identityId, null]; }
  }));

  let uploaded = 0;
  for (const c of candidates) {
    const facts = c.candidateIdentityId ? factsByIdentity.get(c.candidateIdentityId) : null;
    const payload = canonicalPayload(c, facts);
    const hash = hashPayload(payload);
    if (c.poolSync?.uploadedHash === hash) continue; // unchanged
    try {
      const r = await fetch(`${POOL_URL}/api/pool/ingest`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${BOX_TOKEN}`,
        },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(`pool HTTP ${r.status}`);
      await prisma.candidatePoolSync.upsert({
        where: { candidateId: c.id },
        create: { id: randomUUID(), candidateId: c.id, uploadedHash: hash, uploadedAt: new Date() },
        update: { uploadedHash: hash, uploadedAt: new Date(), lastError: null },
      });
      uploaded += 1;
    } catch (err) {
      await prisma.candidatePoolSync.upsert({
        where: { candidateId: c.id },
        create: { id: randomUUID(), candidateId: c.id, lastError: String(err) },
        update: { lastError: String(err) },
      });
    }
  }
  return uploaded;
}

let totalUploaded = 0;
for (let tick = 0; tick < MAX_TICKS; tick++) {
  const n = await syncBatch();
  if (n === 0) break;
  totalUploaded += n;
  console.log(`[pool-sync] tick ${tick}: uploaded ${n}, total ${totalUploaded}`);
}

console.log(`[pool-sync] done — uploaded ${totalUploaded} candidate(s)`);
await prisma.$disconnect();
