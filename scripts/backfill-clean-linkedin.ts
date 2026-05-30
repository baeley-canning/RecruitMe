/**
 * One-off: re-clean LinkedIn profileText that was saved as a raw page dump
 * (sidebar "People also viewed", Connect/Message buttons, mutual-connection +
 * connection-prompt lines) — the scraper used to bypass the extension's
 * sanitizer. NON-DESTRUCTIVE: re-runs the SAME sanitizeCapturedLinkedInText
 * over affected candidates and updates profileText in place (never deletes a
 * candidate); skips any result that would be empty/too short.
 *
 *   node --import tsx scripts/backfill-clean-linkedin.ts          # dry run (default)
 *   node --import tsx scripts/backfill-clean-linkedin.ts --apply  # write changes
 */
import { prisma } from "../src/lib/db";
import { sanitizeCapturedLinkedInText, extractIdentityFromLinkedInProfileText } from "../src/lib/linkedin-capture";

const APPLY = process.argv.includes("--apply");

async function main() {
  // Cover both defects in one pass:
  //  (a) captures carrying LinkedIn page-chrome → re-sanitize profileText;
  //  (b) LinkedIn captures with an empty headline → derive it from the text.
  // Scoped to likely-LinkedIn rows (chrome markers OR extension-source missing
  // a headline) so we never touch JobAdder CVs. Sanitizer + extractor are
  // no-ops on already-clean / already-headlined rows.
  const rows = await prisma.candidate.findMany({
    where: {
      profileText: { not: null },
      OR: [
        { profileText: { contains: "More profiles for you" } },
        { profileText: { contains: "People you may know" } },
        { profileText: { contains: "is a mutual connection" } },
        { profileText: { contains: "are mutual connections" } },
        { profileText: { contains: "Save in Sales Navigator" } },
        { profileText: { contains: "Now is a great time to start a conversation" } },
        { profileText: { contains: "mutual connection" } },
        { source: "extension", headline: null },
      ],
    },
    select: { id: true, name: true, headline: true, profileText: true },
  });

  let textChanged = 0;
  let headlineSet = 0;
  const samples: Array<{ name: string | null; before: number; after: number; headline?: string }> = [];
  for (const r of rows) {
    if (!r.profileText) continue;
    const cleaned = sanitizeCapturedLinkedInText(r.profileText);
    const data: { profileText?: string; profileTextHash?: null; headline?: string } = {};

    if (cleaned !== r.profileText && cleaned.length >= 50) {
      data.profileText = cleaned;
      data.profileTextHash = null; // re-score on next demand (text changed)
      textChanged += 1;
    }
    if (!r.headline) {
      const derived = extractIdentityFromLinkedInProfileText(cleaned);
      if (derived.headline) {
        data.headline = derived.headline;
        headlineSet += 1;
      }
    }
    if (Object.keys(data).length === 0) continue;
    if (samples.length < 5) {
      samples.push({ name: r.name, before: r.profileText.length, after: cleaned.length, headline: data.headline });
    }
    if (APPLY) await prisma.candidate.update({ where: { id: r.id }, data });
  }

  console.log(JSON.stringify({ mode: APPLY ? "APPLY" : "DRY-RUN", scanned: rows.length, textChanged, headlineSet, samples }, null, 2));
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("backfill error:", e instanceof Error ? e.message : String(e));
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
