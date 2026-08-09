/**
 * Real-Postgres smoke test for the raw SQL added on 2026-07-28 (PDL as a
 * durable search source).
 *
 * The unit suite mocks `@/lib/db`, so a statement Postgres would REJECT passes
 * there and fails in production instead — which is exactly how the PDL search
 * integration shipped broken (an illegal `LIMIT` inside the query returned 0
 * results for days). These statements are the new risk surface:
 *   • attachPdlResults — INSERT … ON CONFLICT with a jsonb source-merge
 *   • recomputeCounts  — now references the newly added "pdlCount" column
 *
 * INERT unless SMOKE_DB=1 AND DATABASE_URL are set; the deploy gate runs it
 * after build, before restart. Must NOT vi.mock("@/lib/db") — it needs the
 * real client.
 *
 * Every run created here is tracked and deleted in afterAll (delete cascades to
 * result rows), so the test leaves nothing behind.
 */

import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import {
  attachPdlResults,
  createRun,
  loadRunSnapshot,
  recomputeCounts,
} from "@/lib/search-run";
import { parseBooleanQuery } from "@/lib/boolean-query";

const ENABLED = process.env.SMOKE_DB === "1" && !!process.env.DATABASE_URL;
const d = ENABLED ? describe : describe.skip;

// EVERY run id, not just the latest. Tracking a single id leaks every run but
// the last into the real database on each deploy.
const createdRunIds: string[] = [];

async function newRun(query: string) {
  const run = await createRun({
    orgId: null,
    jobId: null,
    requestedBy: null,
    rawQuery: query,
    parsedQuery: parseBooleanQuery(query),
    location: null,
    sources: ["pdl"],
    libraryStatus: "skipped",
    linkedinStatus: "skipped",
    seekStatus: "skipped",
    pdlStatus: "complete",
  });
  createdRunIds.push(run.id);
  return run;
}

const pdlRow = (name: string, linkedinUrl: string | null) => ({
  name,
  headline: `${name} headline`,
  location: "Wellington",
  linkedinUrl,
  snippet: `${name} snippet`,
});

// Real network round-trips to Postgres (over the public proxy when run from a
// laptop) routinely exceed vitest's 5s default — that measures latency, not
// correctness. 30s keeps the assertion the thing under test.
const TIMEOUT_MS = 30_000;

d("PDL raw-SQL smoke (real Postgres)", () => {
  afterAll(async () => {
    for (const id of createdRunIds) {
      try {
        await prisma.searchRun.delete({ where: { id } });
      } catch {
        // Already gone / cascade removed it — cleanup must never fail the run.
      }
    }
  });

  it("attaches PDL results to a run and tags them with the pdl source", async () => {
    const run = await newRun("smoke pdl attach");
    await attachPdlResults(run.id, [
      pdlRow("Smoke Alice", "https://www.linkedin.com/in/smoke-alice"),
      pdlRow("Smoke Bob", "https://www.linkedin.com/in/smoke-bob"),
    ]);

    const snapshot = await loadRunSnapshot(run.id);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.results ?? []).toHaveLength(2);
    for (const row of snapshot!.results ?? []) {
      expect(row.sources).toContain("pdl");
    }
  }, TIMEOUT_MS);

  it("re-attaching the same people does not duplicate them", async () => {
    const run = await newRun("smoke pdl idempotent");
    const rows = [pdlRow("Smoke Carol", "https://www.linkedin.com/in/smoke-carol")];

    await attachPdlResults(run.id, rows);
    await attachPdlResults(run.id, rows);

    const snapshot = await loadRunSnapshot(run.id);
    expect(snapshot!.results ?? []).toHaveLength(1);
  }, TIMEOUT_MS);

  it("recomputeCounts fills pdlCount — the newly added column referenced in raw SQL", async () => {
    const run = await newRun("smoke pdl counts");
    await attachPdlResults(run.id, [
      pdlRow("Smoke Dave", "https://www.linkedin.com/in/smoke-dave"),
      pdlRow("Smoke Eve", "https://www.linkedin.com/in/smoke-eve"),
    ]);
    await recomputeCounts(run.id);

    const snapshot = await loadRunSnapshot(run.id);
    expect(snapshot!.run.counts.pdl).toBe(2);
    expect(snapshot!.run.counts.total).toBe(2);
  }, TIMEOUT_MS);

  it("stores a PDL hit with no LinkedIn URL (mergeKey falls back to the name)", async () => {
    const run = await newRun("smoke pdl no-url");
    await attachPdlResults(run.id, [pdlRow("Smoke Frank", null)]);

    const snapshot = await loadRunSnapshot(run.id);
    expect(snapshot!.results ?? []).toHaveLength(1);
  }, TIMEOUT_MS);
});
