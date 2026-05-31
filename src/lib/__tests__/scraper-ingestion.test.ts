import { beforeEach, describe, expect, it, vi } from "vitest";
import { normaliseSeekUrl } from "@/lib/seek";

// Mock only the DB; the URL normalisers (linkedin/seek/identity-merge) are pure
// and run for real so the test exercises the actual key/url logic.
const dbMocks = vi.hoisted(() => ({
  prisma: {
    candidateIdentity: {
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    candidateIdentityAlias: {
      create: vi.fn(),
    },
    candidate: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/db", () => dbMocks);

import { ingestScraperResult } from "@/lib/scraper-ingestion";

const SEEK_URL = "https://www.seek.com.au/profile/jane-doe-12345?ref=tracking";

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.prisma.candidateIdentity.updateMany.mockResolvedValue({ count: 0 });
  dbMocks.prisma.candidateIdentityAlias.create.mockResolvedValue({});
  dbMocks.prisma.candidate.findFirst.mockResolvedValue(null);
  dbMocks.prisma.candidate.create.mockResolvedValue({});
  dbMocks.prisma.candidate.update.mockResolvedValue({});
});

describe("ingestScraperResult — SEEK seekUrl is written on the Candidate row", () => {
  it("create stamps the normalised seekUrl (was silently dropped before)", async () => {
    dbMocks.prisma.candidateIdentity.findFirst.mockResolvedValue(null);
    dbMocks.prisma.candidateIdentity.create.mockResolvedValue({ id: "identity-1" });

    const res = await ingestScraperResult({
      orgId: "org-1",
      platform: "seek",
      profileUrl: SEEK_URL,
      profileText: "Jane Doe — Senior RF Engineer, Wellington. 10 years experience.",
      name: "Jane Doe",
    });

    expect(res.candidateAction).toBe("created_new");
    const createArg = dbMocks.prisma.candidate.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(createArg.data.seekUrl).toBe(normaliseSeekUrl(SEEK_URL));
    expect(createArg.data.source).toBe("seek_scraper");
  });

  it("update stamps seekUrl on the existing row and dedupes by it (no duplicate create)", async () => {
    dbMocks.prisma.candidateIdentity.findFirst.mockResolvedValue({ id: "identity-1" });
    // The SEEK existing-candidate lookup is now BY seekUrl (was jobAdderUrl, so
    // it never matched and duplicated every scrape). Return the prior row.
    dbMocks.prisma.candidate.findFirst.mockResolvedValue({ id: "cand-1", profileText: "old" });

    const res = await ingestScraperResult({
      orgId: "org-1",
      platform: "seek",
      profileUrl: SEEK_URL,
      profileText: "Jane Doe — updated profile text, now 11 years experience.",
      name: "Jane Doe",
    });

    expect(res.candidateAction).toBe("updated_existing");
    expect(res.candidateId).toBe("cand-1");
    expect(dbMocks.prisma.candidate.create).not.toHaveBeenCalled();
    // The lookup that found the row must have queried seekUrl, not jobAdderUrl.
    const lookupWhere = dbMocks.prisma.candidate.findFirst.mock.calls.at(-1)![0].where as Record<string, unknown>;
    expect(lookupWhere.seekUrl).toBe(normaliseSeekUrl(SEEK_URL));
    const updateArg = dbMocks.prisma.candidate.update.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(updateArg.data.seekUrl).toBe(normaliseSeekUrl(SEEK_URL));
  });
});

describe("ingestScraperResult — SEEK + LinkedIn cross-key identity backfill", () => {
  it("backfills identity.seekUrl from profileUrl when a SEEK scrape resolves to a LinkedIn identity", async () => {
    // identityMergeKey prefers linkedinUrl, so the identity is FOUND by LinkedIn.
    // The SEEK URL lives in profileUrl (args.seekUrl is absent) — it must still
    // backfill the identity's seekUrl, else a later SEEK-only hit can't merge.
    const LINKEDIN_URL = "https://www.linkedin.com/in/jane-doe-12345";
    dbMocks.prisma.candidateIdentity.findFirst.mockResolvedValue({ id: "identity-1" });
    // No existing Candidate row → create path (also asserts the Candidate gets seekUrl).
    dbMocks.prisma.candidate.findFirst.mockResolvedValue(null);

    await ingestScraperResult({
      orgId: "org-1",
      platform: "seek",
      profileUrl: SEEK_URL,
      linkedinUrl: LINKEDIN_URL,
      profileText: "Jane Doe — Senior RF Engineer, Wellington.",
      name: "Jane Doe",
    });

    // Identity backfill: updateMany writes the normalised SEEK URL, gated on
    // seekUrl IS NULL (the existing "don't clobber" safety pattern).
    expect(dbMocks.prisma.candidateIdentity.updateMany).toHaveBeenCalledTimes(1);
    const idtyUpdate = dbMocks.prisma.candidateIdentity.updateMany.mock.calls[0][0] as {
      where: Record<string, unknown>; data: Record<string, unknown>;
    };
    expect(idtyUpdate.data.seekUrl).toBe(normaliseSeekUrl(SEEK_URL));
    expect(idtyUpdate.where.seekUrl).toBeNull();

    // The Candidate row also carries the SEEK URL (created under the LinkedIn key).
    const createArg = dbMocks.prisma.candidate.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(createArg.data.seekUrl).toBe(normaliseSeekUrl(SEEK_URL));
  });
});

describe("ingestScraperResult — P2002 identity race", () => {
  it("recovers when the refetch finds the racing row (no throw)", async () => {
    // Initial lookup → null (we try to create); create loses the race (P2002);
    // refetch → the winning row.
    dbMocks.prisma.candidateIdentity.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "identity-winner" });
    dbMocks.prisma.candidateIdentity.create.mockRejectedValue({ code: "P2002" });

    const res = await ingestScraperResult({
      orgId: "org-1",
      platform: "seek",
      profileUrl: SEEK_URL,
      profileText: "x".repeat(50),
      name: "Jane Doe",
    });

    expect(res.identityAction).toBe("found_existing");
    expect(res.identityId).toBe("identity-winner");
  });

  it("THROWS when P2002 fires but the refetch finds nothing — no keyless orphan identity", async () => {
    // Both the initial lookup AND the post-P2002 refetch return null: an
    // inconsistent state. The old code fell through and created a name-only
    // identity with no merge key (an orphan no future scrape could match).
    // It must throw instead.
    dbMocks.prisma.candidateIdentity.findFirst.mockResolvedValue(null);
    dbMocks.prisma.candidateIdentity.create.mockRejectedValue({ code: "P2002" });

    await expect(ingestScraperResult({
      orgId: "org-1",
      platform: "seek",
      profileUrl: SEEK_URL,
      profileText: "x".repeat(50),
      name: "Jane Doe",
    })).rejects.toThrow(/keyless orphan/i);

    // Must NOT have fallen through to the second (name-only) identity create…
    expect(dbMocks.prisma.candidateIdentity.create).toHaveBeenCalledTimes(1);
    // …nor created a Candidate under it.
    expect(dbMocks.prisma.candidate.create).not.toHaveBeenCalled();
  });

  it("still rethrows non-P2002 identity-create errors", async () => {
    dbMocks.prisma.candidateIdentity.findFirst.mockResolvedValue(null);
    dbMocks.prisma.candidateIdentity.create.mockRejectedValue(new Error("connection reset"));

    await expect(ingestScraperResult({
      orgId: "org-1",
      platform: "seek",
      profileUrl: SEEK_URL,
      profileText: "x".repeat(50),
      name: "Jane Doe",
    })).rejects.toThrow(/connection reset/);
  });
});

describe("ingestScraperResult — D2 thin/junk LinkedIn rejection", () => {
  const LINKEDIN_URL = "https://www.linkedin.com/in/jane-doe-12345";

  it("THROWS on a thin LinkedIn profile (<200 chars after sanitising) — no Candidate created", async () => {
    await expect(ingestScraperResult({
      orgId: "org-1",
      platform: "linkedin",
      profileUrl: LINKEDIN_URL,
      profileText: "Jane Doe\nSenior Engineer\nAuckland", // well under 200 chars
      name: "Jane Doe",
    })).rejects.toThrow(/usable profile text/i);

    expect(dbMocks.prisma.candidate.create).not.toHaveBeenCalled();
    expect(dbMocks.prisma.candidateIdentity.create).not.toHaveBeenCalled();
  });

  it("THROWS when no usable name AND no headline can be recovered — no 'Unknown' Candidate", async () => {
    // 200+ chars of mumbled lowercase chrome: the name is junk and the
    // extractor can pull no headline (no role keyword, no separator, not
    // Title-Case). Must reject rather than persist an Unknown row.
    const junk =
      "this captured blob is mostly mumbled navigation chrome with no clear " +
      "person described here just lots of filler words repeated over and over " +
      "until it crosses two hundred characters but still says nothing useful";
    await expect(ingestScraperResult({
      orgId: "org-1",
      platform: "linkedin",
      profileUrl: LINKEDIN_URL,
      profileText: junk,
      name: "view profile", // lowercase → fails looksLikeCapturedName
    })).rejects.toThrow(/no usable name or headline/i);

    expect(dbMocks.prisma.candidate.create).not.toHaveBeenCalled();
  });

  it("ACCEPTS a healthy LinkedIn profile (real name + enough text) — creates the Candidate", async () => {
    dbMocks.prisma.candidateIdentity.findFirst.mockResolvedValue(null);
    dbMocks.prisma.candidateIdentity.create.mockResolvedValue({ id: "identity-1" });

    const profileText =
      "Jane Doe\nSenior Software Engineer at Acme\nAuckland, New Zealand\nAbout\n" +
      "Experienced engineer with a decade building distributed systems, cloud platforms, and developer tooling across multiple high-growth product teams.";

    const res = await ingestScraperResult({
      orgId: "org-1",
      platform: "linkedin",
      profileUrl: LINKEDIN_URL,
      profileText,
      name: "Jane Doe",
    });

    expect(res.candidateAction).toBe("created_new");
    expect(dbMocks.prisma.candidate.create).toHaveBeenCalledTimes(1);
  });

  it("RECOVERS a real name from profileText when the scraper passed a junk card name", async () => {
    // The search card leaked "View profile" into the name slot, but the real
    // name is the first profile line. derived.name (itself gated by
    // looksLikeCapturedName) must override the junk so the profile is NOT
    // wrongly rejected by the D2 name/headline guard.
    dbMocks.prisma.candidateIdentity.findFirst.mockResolvedValue(null);
    dbMocks.prisma.candidateIdentity.create.mockResolvedValue({ id: "identity-1" });

    const profileText =
      "Jane Doe\nSenior Software Engineer at Acme\nAuckland, New Zealand\nAbout\n" +
      "Experienced engineer with a decade building distributed systems, cloud platforms, and developer tooling across multiple high-growth product teams.";

    const res = await ingestScraperResult({
      orgId: "org-1",
      platform: "linkedin",
      profileUrl: LINKEDIN_URL,
      profileText,
      name: "View profile", // junk card text → must be replaced by derived "Jane Doe"
    });

    expect(res.candidateAction).toBe("created_new");
    const createArg = dbMocks.prisma.candidate.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(createArg.data.name).toBe("Jane Doe");
  });
});
