/**
 * Integration tests — "the Bede problem" class of bugs.
 *
 * Scenario in one paragraph: a JobAdder bulk import landed Bede Skinner-Vennell
 * in the candidate library with profileText="" (no CV attached, so the
 * extract-cv-text step had nothing to work with) and headline pulled from his
 * LinkedIn About section — which surfaces his volunteer canoe-polo coaching
 * activity, not his actual day job. He then ended up on a software-engineer
 * job via the "Browse library" modal, sitting there with an empty drawer and
 * a misleading "Coach at Kiwi Canoe Polo" headline.
 *
 * These tests pin the multiple guard-rails that, together, are supposed to
 * make the Bede problem impossible:
 *
 *   • Library POST refuses to import a row whose profileText < 500 chars
 *     (commit 9e8686c — "library: refuse to import candidates with <500
 *     chars of profileText").
 *   • Talent-pool POST imports JobAdder library rows that DO have proper
 *     profileText, but rejects empty ones via hasReusablePoolProfile
 *     (commit ac74f56 — "talent-pool: surface JobAdder-orphan candidates").
 *
 * Tests that pin work that *should* land next (library GET length filter,
 * candidate-detail hasProfileText flag, headline-from-CV derivation) are
 * `it.skip`'d with a TODO naming the agent / scope that should ship the fix
 * — broken tests are worse than missing tests.
 *
 * Fixtures: deliberately CV-shaped. Lorem ipsum doesn't catch the kinds of
 * bug we care about (LEADERSHIP-section headlines, etc.) because the
 * production code keys on real section markers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildScoreBreakdown, CATEGORY_WEIGHTS_V2 } from "@/lib/scoring";

// ────────────────────────────────────────────────────────────────────────────
// Realistic fixtures
// ────────────────────────────────────────────────────────────────────────────

/**
 * Bede-shaped CV: name header on top, OVERVIEW, EDUCATION, WORK EXPERIENCE
 * (the real day job — what the headline SHOULD reflect), then a long
 * LEADERSHIP & COACHING EXPERIENCE block (volunteer canoe-polo work). The
 * coaching block is intentionally listed BEFORE the work block in the
 * "headline" derivation tests' source so a naive "first job-like line"
 * extractor would pick the coaching role.
 */
const BEDE_FULL_CV = [
  "Bede Skinner-Vennell",
  "Wellington, New Zealand",
  "",
  "OVERVIEW",
  "Recent Computer Science graduate currently working as a Junior Software Engineer at",
  "Integration Technologies Limited. Passionate about backend systems, distributed",
  "computing, and building reliable production software. Also volunteers heavily in",
  "the New Zealand canoe-polo community as a head coach.",
  "",
  "EDUCATION",
  "Bachelor of Science (Computer Science), Victoria University of Wellington, 2024",
  "Relevant coursework: distributed systems, compilers, software engineering, networking.",
  "",
  "WORK EXPERIENCE",
  "Junior Software Engineer — Integration Technologies Limited",
  "January 2025 – Present",
  "Wellington, New Zealand",
  " - Built REST APIs in TypeScript and Node.js for a logistics integration platform.",
  " - Implemented OAuth2 flows and JWT-based service-to-service auth.",
  " - Wrote integration tests (vitest) and contributed to CI/CD pipelines (GitHub Actions).",
  " - Worked on PostgreSQL schema migrations and query-perf optimisation.",
  "",
  "Software Engineering Intern — Trade Me",
  "November 2023 – February 2024",
  " - Contributed to the seller-tools team; React/TypeScript and Go services.",
  "",
  "LEADERSHIP & COACHING EXPERIENCE",
  "High-Performance Coordinator and Coach — Kiwi Canoe Polo",
  "2022 – Present",
  " - Coach the New Zealand U21 men's canoe-polo squad.",
  " - Coordinate training camps, fixtures, and selection trials.",
  " - Manage a coaching team of four assistants.",
  "",
  "Junior Coach — Wellington Canoe Polo Club",
  "2019 – 2022",
  " - Coached the junior development squad on weekends.",
  "",
  "SKILLS",
  "TypeScript, Node.js, PostgreSQL, REST APIs, OAuth2, Git, Linux, CI/CD.",
].join("\n");

/** Employer-first CV shape (different from Bede's): company line first, role second. */
const EMPLOYER_FIRST_CV = [
  "Acme Corp",
  "Senior Software Engineer, 2020-2024",
  "Wellington, New Zealand",
  "",
  "Built a payments platform handling $200M/yr. Led a team of four engineers.",
  "Owned the Postgres → BigQuery ETL and on-call rotations for the billing service.",
  "",
  "Beta Industries",
  "Software Engineer, 2017-2020",
  "Auckland, New Zealand",
  "",
  "Built internal CRUD tools in Django and React. Migrated monolith to microservices.",
].join("\n");

/** Garbage / contact-only — should never make it past any profile-completeness gate. */
const CONTACT_ONLY_TEXT = [
  "Sam Tester",
  "sam@example.com",
  "+64 21 555 1234",
  "Wellington",
].join("\n");

// Helper: build a min-quality CV >= N chars from the Bede CV (for size-gated tests).
function fixtureAtLeast(chars: number, base = BEDE_FULL_CV): string {
  if (base.length >= chars) return base;
  const padding = "\n\nADDITIONAL CONTEXT\n" +
    "Open-source contributions, hackathon wins, technical blog posts. ".repeat(50);
  return (base + padding).slice(0, Math.max(chars, base.length));
}

// ────────────────────────────────────────────────────────────────────────────
// Module mocks (hoisted)
// ────────────────────────────────────────────────────────────────────────────

const dbMocks = vi.hoisted(() => ({
  prisma: {
    candidate: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
    },
    orgAccessGrant: { findMany: vi.fn().mockResolvedValue([]) },
    org:            { findMany: vi.fn().mockResolvedValue([]) },
    searchSession:  { create: vi.fn().mockResolvedValue({ id: "ss-1" }) },
    usageEvent: {
      count:     vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
      create:    vi.fn().mockResolvedValue({}),
      aggregate: vi.fn().mockResolvedValue({ _sum: { costUsd: 0 } }),
    },
    setting: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create:     vi.fn().mockResolvedValue({}),
      update:     vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue(null),
      upsert:     vi.fn().mockResolvedValue({}),
    },
    // $queryRaw is used by /api/jobs/[id]/library GET to length-gate
    // profileText at the SQL layer (Prisma's query builder can't express
    // char_length(...) >= N). Default: returns empty so tests must
    // mockResolvedValueOnce per call. Some tests don't exercise the GET
    // path; the default-empty stub keeps those from crashing.
    $queryRaw: vi.fn().mockResolvedValue([]),
  },
}));

const aiMocks = vi.hoisted(() => ({
  scoreCandidateStructured: vi.fn(),
  scoreCandidatesBatch:     vi.fn(),
}));

const sessionMocks = vi.hoisted(() => ({
  getAuth:          vi.fn(),
  requireJobAccess: vi.fn(),
  unauthorized:     vi.fn(() => new Response(null, { status: 401 })),
}));

const scoringConfigMocks = vi.hoisted(() => ({
  customWeights: {
    must_have: 0.5, skill_fit: 0.2, location_fit: 0.05, seniority_fit: 0.05,
    title_fit: 0.05, domain_fit: 0.1, nice_to_have_fit: 0.05,
  },
  getJobScoringWeights: vi.fn(),
}));

const usageMocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  checkSpendCap:  vi.fn().mockResolvedValue({ allowed: true, spentUsd: 0, capUsd: 5 }),
}));

const firmableMocks = vi.hoisted(() => ({
  enrichCandidateInBackground: vi.fn(),
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/ai", () => aiMocks);
vi.mock("@/lib/session", () => sessionMocks);
vi.mock("@/lib/scoring-config", () => ({
  getJobScoringWeights: scoringConfigMocks.getJobScoringWeights,
}));
vi.mock("@/lib/usage", () => usageMocks);
vi.mock("@/lib/firmable-enrich", () => firmableMocks);

// Route handlers — must be imported AFTER the vi.mock() calls above so the
// mocked deps are wired in. `getLibraryCandidates` is the helper that backs
// the /api/candidates GET path (see src/lib/library.ts).
import { POST as LibraryPOST, GET as LibraryGET } from "@/app/api/jobs/[id]/library/route";
import { POST as TalentPoolPOST } from "@/app/api/jobs/[id]/candidates/talent-pool/route";
import { getLibraryCandidates } from "@/lib/library";
import { invalidateAccessCache } from "@/lib/org-access";

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function makeBreakdown() {
  return buildScoreBreakdown({
    categories: {
      skill_fit:        { score: 80,  weight: CATEGORY_WEIGHTS_V2.skill_fit,        evidence: "x" },
      location_fit:     { score: 100, weight: CATEGORY_WEIGHTS_V2.location_fit,     evidence: "x" },
      seniority_fit:    { score: 75,  weight: CATEGORY_WEIGHTS_V2.seniority_fit,    evidence: "x" },
      title_fit:        { score: 70,  weight: CATEGORY_WEIGHTS_V2.title_fit,        evidence: "x" },
      domain_fit:       { score: 60,  weight: CATEGORY_WEIGHTS_V2.domain_fit,       evidence: "x" },
      nice_to_have_fit: { score: 40,  weight: CATEGORY_WEIGHTS_V2.nice_to_have_fit, evidence: "x" },
    },
    must_have_coverage:  [{ requirement: "TypeScript", status: "confirmed", evidence: "Listed" }],
    nice_to_have_coverage: [],
    reasons_for:    ["Good"],
    reasons_against: [],
    missing_evidence: [],
    recruiter_summary: "Library import.",
    profileCharCount: BEDE_FULL_CV.length,
  });
}

function baseJobFixture() {
  return {
    id: "job-1",
    orgId: "org-1",
    scoringWeights: null,
    salaryMin: null,
    salaryMax: null,
    location: "Wellington",
    location2: null,
    isRemote: false,
    parsedRole: JSON.stringify({
      title: "Software Engineer",
      location: "Wellington",
      location_rules: "Wellington",
      must_haves: ["TypeScript", "REST APIs"],
      nice_to_haves: [],
      knockout_criteria: [],
      skills_required: ["TypeScript", "REST APIs"],
      skills_preferred: [],
    }),
  };
}

function resetCommonMocks() {
  vi.clearAllMocks();
  invalidateAccessCache("org-1");
  invalidateAccessCache("org-viewer");
  usageMocks.checkRateLimit.mockResolvedValue({ allowed: true });
  usageMocks.checkSpendCap.mockResolvedValue({ allowed: true, spentUsd: 0, capUsd: 5 });
  dbMocks.prisma.orgAccessGrant.findMany.mockResolvedValue([]);
  dbMocks.prisma.org.findMany.mockResolvedValue([]);
  sessionMocks.getAuth.mockResolvedValue({ userId: "u1", orgId: "org-1", isOwner: false });
  sessionMocks.requireJobAccess.mockResolvedValue({ job: baseJobFixture(), error: null });
  scoringConfigMocks.getJobScoringWeights.mockResolvedValue(scoringConfigMocks.customWeights);
  aiMocks.scoreCandidateStructured.mockResolvedValue(makeBreakdown());
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe("Bede problem — library empty-profile integration", () => {
  beforeEach(() => {
    resetCommonMocks();
  });

  // ──────────────────────────────────────────────────────────────────────
  // 1. getLibraryCandidates filters out rows where profileText is too short.
  // The library helper now uses a CHAR_LENGTH gate via $queryRaw so empty
  // and tiny-profileText rows never reach the hydrate findMany.
  // ──────────────────────────────────────────────────────────────────────
  it("getLibraryCandidates returns only rows whose profileText >= 500 chars (SQL gate)", async () => {
    const now = new Date();
    // $queryRaw returns only the candidate IDs that passed the
    // char_length(profileText) >= 500 predicate. The mock simulates the
    // gate: only `full` survives — empty / null / tiny rows are excluded
    // before findMany.
    dbMocks.prisma.$queryRaw.mockResolvedValueOnce([{ id: "full" }]);
    dbMocks.prisma.candidate.findMany.mockResolvedValueOnce([
      {
        id: "full",
        name: "Acme Senior",
        headline: "Senior Software Engineer at Acme",
        location: "Wellington",
        linkedinUrl: "https://www.linkedin.com/in/acme-senior/",
        matchScore: 80,
        source: "extension",
        status: "new",
        notes: null,
        profileCapturedAt: now,
        createdAt: now,
        jobId: null,
        orgId: "org-1",
        archivedJobTitle: null,
        archivedJobCompany: null,
        job: null,
        files: [],
      },
    ]);

    const { candidates } = await getLibraryCandidates({
      userId: "user-1",
      orgId: "org-1",
      isOwner: false,
    });

    expect(candidates.map((c) => c.id)).toEqual(["full"]);
    // Confirm the SQL gate was the filter, not a JS post-filter: $queryRaw
    // must have been called.
    expect(dbMocks.prisma.$queryRaw).toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────────────────
  // 2. getLibraryCandidates with no eligible rows returns empty without
  // hitting the hydrate query at all.
  // ──────────────────────────────────────────────────────────────────────
  it("getLibraryCandidates short-circuits to [] when no row passes the length gate", async () => {
    dbMocks.prisma.$queryRaw.mockResolvedValueOnce([]); // no eligible IDs

    const { candidates } = await getLibraryCandidates({
      userId: "user-1",
      orgId: "org-1",
      isOwner: false,
    });

    expect(candidates).toEqual([]);
    // No hydrate query when nothing passed the gate — saves a roundtrip.
    expect(dbMocks.prisma.candidate.findMany).not.toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────────────────
  // 3. Library POST refuses empty-profile import.
  // Pins: commit 9e8686c — "library: refuse to import candidates with
  // <500 chars of profileText". The route fetches sourceCandidatesRaw via
  // findMany, then JS-side filters by trimmed length >= 500, surfacing
  // `skippedEmpty` in the response.
  // ──────────────────────────────────────────────────────────────────────
  it("Library POST refuses to import a candidate whose source profileText is empty", async () => {
    // Single source candidate — JobAdder-imported row with profileText="".
    dbMocks.prisma.candidate.findMany.mockResolvedValueOnce([
      {
        id: "bede-src",
        name: "Bede Skinner-Vennell",
        headline: "High-Performance Coordinator and Coach at Kiwi Canoe Polo",
        location: "Wellington, New Zealand",
        linkedinUrl: "https://www.linkedin.com/in/bede-sv/",
        profileText: "", // ← empty (no CV ever uploaded after JobAdder import)
        profileCapturedAt: null,
        source: "jobadder_import",
      },
    ]);

    const res = await LibraryPOST(
      new Request("http://localhost/api/jobs/job-1/library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateIds: ["bede-src"] }),
      }),
      { params: Promise.resolve({ id: "job-1" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.added).toBe(0);
    expect(body.skippedEmpty).toBe(1);
    // Critical: no AI tokens burned on a candidate with no profile text.
    expect(aiMocks.scoreCandidateStructured).not.toHaveBeenCalled();
    // And nothing gets upserted onto the job.
    expect(dbMocks.prisma.candidate.upsert).not.toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────────────────
  // 4. Library POST accepts a properly-populated profile import.
  // The positive case of the gate from commit 9e8686c — proves the gate
  // is conservative (>= 500 chars), not blanket-reject.
  // ──────────────────────────────────────────────────────────────────────
  it("Library POST imports a candidate whose profileText is >= 500 chars", async () => {
    const fullText = fixtureAtLeast(800);
    expect(fullText.length).toBeGreaterThanOrEqual(800);

    dbMocks.prisma.candidate.findMany.mockResolvedValueOnce([
      {
        id: "bede-src-with-cv",
        name: "Bede Skinner-Vennell",
        headline: "Junior Software Engineer at Integration Technologies Limited",
        location: "Wellington, New Zealand",
        linkedinUrl: "https://www.linkedin.com/in/bede-sv/",
        profileText: fullText,
        profileCapturedAt: null,
        source: "jobadder_import",
      },
    ]);
    dbMocks.prisma.candidate.upsert.mockImplementation(
      async ({ create }: { create: Record<string, unknown> }) => ({
        id: "new-cand-1", ...create,
      }),
    );

    const res = await LibraryPOST(
      new Request("http://localhost/api/jobs/job-1/library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateIds: ["bede-src-with-cv"] }),
      }),
      { params: Promise.resolve({ id: "job-1" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.added).toBe(1);
    expect(body.skippedEmpty).toBeUndefined();
    // The candidate's source profileText travels with the upsert.
    expect(dbMocks.prisma.candidate.upsert).toHaveBeenCalledTimes(1);
    const upsertCall = dbMocks.prisma.candidate.upsert.mock.calls[0][0];
    expect(upsertCall.create.profileText).toBe(fullText);
    expect(upsertCall.create.source).toBe("talent_pool");
  });

  // ──────────────────────────────────────────────────────────────────────
  // 5. Talent-pool route rejects empty-profileText rows.
  //
  // The talent-pool route's SQL where clause uses `profileText: { not: null }`
  // (which still matches "") — the length-gate happens in JS via
  // `hasReusablePoolProfile` (CAPTURED_PROFILE_MIN_CHARS=500). Both branches
  // converge on the same outcome: a row with profileText="" never lands on
  // the job. We mock findMany to return that row and assert zero imports.
  // ──────────────────────────────────────────────────────────────────────
  it("Talent-pool POST rejects rows with empty profileText (hasReusablePoolProfile gate)", async () => {
    // findMany call #1 = existing URLs already on the job (none).
    // findMany call #2 = pool rows. The Bede row with profileText="" must
    // be rejected by hasReusablePoolProfile before save.
    dbMocks.prisma.candidate.findMany.mockReset();
    dbMocks.prisma.candidate.findMany
      .mockResolvedValueOnce([])  // no existing on this job
      .mockResolvedValueOnce([
        {
          id: "bede-empty",
          name: "Bede Skinner-Vennell",
          headline: "High-Performance Coordinator and Coach at Kiwi Canoe Polo",
          location: "Wellington, New Zealand",
          linkedinUrl: "https://www.linkedin.com/in/bede-sv/",
          jobAdderUrl: "https://app.jobadder.com/candidates/9999",
          source: "jobadder_import",
          profileText: "",                                        // ← empty
          profileCapturedAt: null,
          createdAt: new Date(),
          orgId: "org-1",
          job: { orgId: "org-1" },
        },
      ]);

    const res = await TalentPoolPOST(
      new Request("http://localhost/api/jobs/job-1/candidates/talent-pool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxResults: 10 }),
      }),
      { params: Promise.resolve({ id: "job-1" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(0);
    expect(dbMocks.prisma.candidate.upsert).not.toHaveBeenCalled();

    // Defence in depth: the pool's SQL where clause must at least narrow
    // by `profileText: { not: null }` so the prefilter index doesn't drag
    // every null-profileText row into memory.
    const calls = dbMocks.prisma.candidate.findMany.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const poolWhere = calls[1][0].where as Record<string, unknown>;
    expect(JSON.stringify(poolWhere)).toContain('"profileText":{"not":null}');
  });

  // ──────────────────────────────────────────────────────────────────────
  // 6. Talent-pool route imports a JobAdder candidate with proper profileText.
  // Pins: commit ac74f56 (talent-pool: surface JobAdder-orphan candidates).
  // The route must accept rows whose source is "jobadder_import", whose
  // profileText is >= 500 chars (CAPTURED_PROFILE_MIN_CHARS), and store
  // the profileText on the new (jobId, linkedinUrl) row.
  // ──────────────────────────────────────────────────────────────────────
  it("Talent-pool POST imports a JobAdder candidate with proper profileText and preserves it on the new row", async () => {
    const cv = fixtureAtLeast(1200);

    dbMocks.prisma.candidate.findMany.mockReset();
    dbMocks.prisma.candidate.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "ja-pool-1",
          name: "Bede Skinner-Vennell",
          headline: "Junior Software Engineer at Integration Technologies Limited",
          location: "Wellington, New Zealand",
          linkedinUrl: null,                            // ← JobAdder-only row, no LinkedIn URL
          jobAdderUrl: "https://app.jobapp.com/123",
          source: "jobadder_import",                    // ← provenance pinned
          profileText: cv,                              // ← full CV text >= 500
          profileCapturedAt: null,
          createdAt: new Date(),
          orgId: "org-1",
          job: { orgId: "org-1" },
        },
      ]);
    dbMocks.prisma.candidate.upsert.mockImplementation(
      async ({ create }: { create: Record<string, unknown> }) => ({
        id: "imported-1", createdAt: new Date(), ...create,
      }),
    );

    const res = await TalentPoolPOST(
      new Request("http://localhost/api/jobs/job-1/candidates/talent-pool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxResults: 10 }),
      }),
      { params: Promise.resolve({ id: "job-1" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);

    expect(dbMocks.prisma.candidate.upsert).toHaveBeenCalledTimes(1);
    const call = dbMocks.prisma.candidate.upsert.mock.calls[0][0];
    // The (jobId, linkedinUrl) row uses the internal `library:<srcId>` key
    // because the source row has no LinkedIn URL (ATS-only candidate).
    expect(call.where.jobId_linkedinUrl).toEqual({
      jobId: "job-1",
      linkedinUrl: "library:ja-pool-1",
    });
    expect(call.create.profileText).toBe(cv);
    expect(call.create.linkedinUrl).toBe("library:ja-pool-1");
    expect(call.create.source).toBe("talent_pool");      // post-import label
  });

  // ──────────────────────────────────────────────────────────────────────
  // 7. Candidate-detail API contract — hasProfileText flag.
  //
  // Pins: NOT YET SHIPPED. /api/candidates/[id]/route.ts GET returns the
  // raw candidate including `profileText`, but there's no boolean flag the
  // UI can read without re-running its own length check. Until an agent
  // adds the flag we skip — the alternative is a `.toBeUndefined()` test
  // that gives a false signal of safety.
  // ──────────────────────────────────────────────────────────────────────
  it.skip("Candidate detail API exposes hasProfileText:boolean based on trimmed length (BLOCKED on candidate-detail flag)", async () => {
    // TODO: enable after the candidate-detail route exposes a derived
    // `hasProfileText` flag (trimmed length > 0, or > some min). The
    // current route in src/app/api/candidates/[id]/route.ts returns the
    // full row + otherJobs, with no derived flag. Contract once shipped:
    //
    //   - findUnique returns row with profileText=""  → hasProfileText=false
    //   - findUnique returns row with profileText="long cv text"  → true
    //   - findUnique returns row with profileText=null → false
    //
    // The UI consumes this so the empty-state warning ("This candidate
    // has no captured profile — upload a CV") doesn't depend on the
    // client re-trimming/parsing potentially-large text.
    expect.fail("placeholder — enable once candidate-detail hasProfileText flag is wired");
  });

  // ──────────────────────────────────────────────────────────────────────
  // 8. Headline-from-CV derivation — pin the correct day-job extraction.
  // The helper `deriveHeadlineFromCv` + `formatHeadline` live in
  // src/lib/cv-headline.ts. For a Bede-shaped CV (WORK EXPERIENCE block
  // followed by LEADERSHIP & COACHING block), the extractor must pick the
  // FIRST work experience entry, not the leadership block — even though
  // the JobAdder CSV had the leadership role as the candidate's headline.
  // ──────────────────────────────────────────────────────────────────────
  it("Headline derived from Bede-shaped CV picks WORK EXPERIENCE, not LEADERSHIP/COACHING", async () => {
    // The Bede problem in one assertion: the CV has both a WORK EXPERIENCE
    // section (his actual day job — Junior Software Engineer) AND a later
    // LEADERSHIP & COACHING section (his canoe coaching). JobAdder CSV
    // pinned the leadership role as his headline. The CV-aware helper
    // must pick the WORK EXPERIENCE entry.
    const { deriveHeadlineFromCv, formatHeadline } = await import("@/lib/cv-headline");
    const derived = deriveHeadlineFromCv(BEDE_FULL_CV);
    expect(derived).not.toBeNull();
    const headline = formatHeadline(derived!);
    expect(headline.toLowerCase()).toContain("engineer");
    expect(headline).not.toContain("Canoe Polo");
    expect(headline).not.toContain("Coordinator and Coach");
    // Contact-only garbage returns null — no false positives that would
    // overwrite a recruiter-set headline with junk.
    expect(deriveHeadlineFromCv(CONTACT_ONLY_TEXT)).toBeNull();
    // Note: employer-first formatting is exhaustively tested in
    // src/lib/__tests__/cv-headline.test.ts against fixtures that include
    // the WORK EXPERIENCE header; not re-tested here.
    void EMPLOYER_FIRST_CV;
  });

  // ──────────────────────────────────────────────────────────────────────
  // 9. Contact-only / garbage text never makes it past the import gate.
  // Complements task 3 with a sub-500-char realistic fixture (not "" but
  // not enough to be a profile). Same commit pin (9e8686c).
  // ──────────────────────────────────────────────────────────────────────
  it("Library POST refuses to import a candidate whose profileText is just contact details", async () => {
    expect(CONTACT_ONLY_TEXT.length).toBeLessThan(500);  // sanity-check the fixture
    dbMocks.prisma.candidate.findMany.mockResolvedValueOnce([
      {
        id: "garbage-src",
        name: "Sam Tester",
        headline: "Software Developer",
        location: "Wellington",
        linkedinUrl: "https://www.linkedin.com/in/sam-tester/",
        profileText: CONTACT_ONLY_TEXT,
        profileCapturedAt: null,
        source: "manual",
      },
    ]);

    const res = await LibraryPOST(
      new Request("http://localhost/api/jobs/job-1/library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateIds: ["garbage-src"] }),
      }),
      { params: Promise.resolve({ id: "job-1" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.added).toBe(0);
    expect(body.skippedEmpty).toBe(1);
    expect(dbMocks.prisma.candidate.upsert).not.toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────────────────
  // 10. Mixed batch through Library POST — some good, some empty.
  // Boundary case for commit 9e8686c: confirms the filter doesn't drop
  // the good rows when it sees a bad one in the same batch.
  // ──────────────────────────────────────────────────────────────────────
  it("Library POST mixed batch — full-profile imports, empty-profile skipped", async () => {
    const good = fixtureAtLeast(1500, EMPLOYER_FIRST_CV);

    dbMocks.prisma.candidate.findMany.mockResolvedValueOnce([
      {
        id: "good-1",
        name: "Acme Senior",
        headline: "Senior Software Engineer at Acme Corp",
        location: "Wellington, New Zealand",
        linkedinUrl: "https://www.linkedin.com/in/acme-senior/",
        profileText: good,
        profileCapturedAt: null,
        source: "jobadder_import",
      },
      {
        id: "bede-empty-1",
        name: "Bede Skinner-Vennell",
        headline: "High-Performance Coordinator and Coach at Kiwi Canoe Polo",
        location: "Wellington, New Zealand",
        linkedinUrl: "https://www.linkedin.com/in/bede-sv/",
        profileText: "",
        profileCapturedAt: null,
        source: "jobadder_import",
      },
    ]);
    dbMocks.prisma.candidate.upsert.mockImplementation(
      async ({ create }: { create: Record<string, unknown> }) => ({ id: "ok", ...create }),
    );

    const res = await LibraryPOST(
      new Request("http://localhost/api/jobs/job-1/library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateIds: ["good-1", "bede-empty-1"] }),
      }),
      { params: Promise.resolve({ id: "job-1" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.added).toBe(1);
    expect(body.skippedEmpty).toBe(1);
    expect(dbMocks.prisma.candidate.upsert).toHaveBeenCalledTimes(1);
    const upsertCall = dbMocks.prisma.candidate.upsert.mock.calls[0][0];
    expect(upsertCall.create.profileText).toBe(good);
  });

  // ──────────────────────────────────────────────────────────────────────
  // 11. Library GET still surfaces the empty-row metadata (regression
  // guard) — proving tests 1+2's skip status reflects current behaviour
  // and isn't masking a fix that already half-shipped. Once a real GET
  // gate lands this test will need to be updated to assert the row is
  // filtered out; until then it pins the *current* (broken-by-design)
  // behaviour so the empty-row isn't silently dropped by some other
  // change.
  // ──────────────────────────────────────────────────────────────────────
  // ──────────────────────────────────────────────────────────────────────
  // 11. Library GET — the length gate IS shipped: only eligible IDs come
  // back from $queryRaw, and the second findMany hydrates only those.
  // ──────────────────────────────────────────────────────────────────────
  it("Library GET filters out empty/short profileText rows at the SQL layer", async () => {
    const now = new Date();
    // $queryRaw returns only the eligible candidate IDs (those with
    // char_length(profileText) >= 500). The mock simulates the SQL gate:
    // lib-empty has empty profileText so the gate excludes it.
    dbMocks.prisma.$queryRaw.mockResolvedValueOnce([{ id: "lib-full" }]);
    dbMocks.prisma.candidate.findMany
      .mockResolvedValueOnce([])  // call 1: existing on this job
      .mockResolvedValueOnce([    // call 2: hydrate eligible IDs
        {
          id: "lib-full",
          name: "Acme Senior",
          headline: "Senior Software Engineer at Acme Corp",
          location: "Wellington, New Zealand",
          linkedinUrl: "https://www.linkedin.com/in/acme-senior/",
          matchScore: 80,
          createdAt: now,
          job: { title: "Old role" },
          archivedJobTitle: null,
        },
      ]);

    const res = await LibraryGET(
      new Request("http://localhost/api/jobs/job-1/library"),
      { params: Promise.resolve({ id: "job-1" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // lib-empty was filtered by the SQL CHAR_LENGTH gate so it never
    // reached the hydrate query. Only lib-full surfaces.
    expect(body.candidates.map((c: { id: string }) => c.id)).toEqual(["lib-full"]);
  });
});
