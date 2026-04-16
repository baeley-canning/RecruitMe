import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { scoreCandidateStructured, predictAcceptance, extractCandidateInfo, cleanCvText } from "@/lib/ai";
import type { ParsedRole } from "@/lib/ai";
import { safeParseJson } from "@/lib/utils";
import { deriveUpdateData } from "@/lib/score-utils";

// ---------------------------------------------------------------------------
// Server-side LinkedIn scraper
// Fetches the public HTML of a LinkedIn profile and extracts readable text.
// Works for publicly visible profiles. Private profiles return status 422.
// ---------------------------------------------------------------------------
async function scrapeLinkedIn(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
    },
    signal: AbortSignal.timeout(12_000),
  });

  if (!res.ok) throw new Error(`http_${res.status}`);

  const html = await res.text();

  // Detect login wall (profile is private / requires auth)
  if (
    html.includes('name="session_password"') ||
    html.includes('type="password"') ||
    (html.includes("authwall") && html.length < 8_000)
  ) {
    throw new Error("private");
  }

  const parts: string[] = [];

  // 1. <title> — "Full Name - Headline | LinkedIn"
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) {
    parts.push(titleMatch[1].replace(/\s*\|\s*LinkedIn\s*$/i, "").trim());
  }

  // 2. <meta name="description"> — summary/headline
  const metaDesc =
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{10,})["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']{10,})["'][^>]+name=["']description["']/i);
  if (metaDesc) parts.push(metaDesc[1]);

  // 3. JSON-LD structured data (schema.org/Person)
  const jsonLdBlocks = [
    ...html.matchAll(
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    ),
  ];
  for (const block of jsonLdBlocks) {
    try {
      const data = JSON.parse(block[1]);
      const list = Array.isArray(data) ? data : [data];
      for (const item of list) {
        if (item["@type"] !== "Person") continue;
        if (item.name) parts.push("Name: " + item.name);
        if (item.jobTitle) parts.push("Current role: " + item.jobTitle);
        if (item.description) parts.push("About: " + item.description);
        if (item.worksFor?.name) parts.push("Company: " + item.worksFor.name);
        if (item.address?.addressLocality)
          parts.push("Location: " + item.address.addressLocality);
        if (item.alumniOf) {
          const schools = (Array.isArray(item.alumniOf) ? item.alumniOf : [item.alumniOf])
            .map((s: { name?: string }) => s.name)
            .filter(Boolean);
          if (schools.length) parts.push("Education: " + schools.join(", "));
        }
      }
    } catch {
      // skip malformed blocks
    }
  }

  // 4. Strip all HTML and grab visible text as a fallback/supplement
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (stripped.length > 200) {
    parts.push(stripped.slice(0, 8_000));
  }

  const result = parts.join("\n\n");
  if (result.trim().length < 80) throw new Error("empty");

  return result;
}

// ---------------------------------------------------------------------------
// Body schema — profileText is optional (provided by bookmarklet postMessage)
// When absent the route scrapes LinkedIn server-side.
// ---------------------------------------------------------------------------
const BodySchema = z.object({
  profileText: z.string().min(50).max(20_000).optional(),
  linkedinUrl: z.string().url().optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; candidateId: string }> }
) {
  const { id: jobId, candidateId } = await params;

  const body = BodySchema.safeParse(await req.json().catch(() => ({})));

  const [candidate, job] = await Promise.all([
    prisma.candidate.findUnique({ where: { id: candidateId } }),
    prisma.job.findUnique({ where: { id: jobId } }),
  ]);

  if (!candidate || !job) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let profileText: string;

  if (body.success && body.data.profileText) {
    // Text already provided (bookmarklet / Tampermonkey postMessage fallback)
    profileText = body.data.profileText;
  } else {
    // ── Primary path: server-side scrape ──
    if (!candidate.linkedinUrl) {
      return NextResponse.json(
        { error: "No LinkedIn URL stored for this candidate." },
        { status: 400 }
      );
    }
    try {
      const raw = await scrapeLinkedIn(candidate.linkedinUrl);
      try {
        profileText = await cleanCvText(raw);
      } catch {
        profileText = raw; // fall back to raw if Claude clean fails
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg === "private") {
        return NextResponse.json(
          {
            error:
              "This profile is private — it requires LinkedIn login to view. Install the Opera extension from LinkedIn setup to capture it while you're logged in.",
            private: true,
          },
          { status: 422 }
        );
      }
      return NextResponse.json(
        {
          error: "Could not fetch the LinkedIn profile. Try again, or paste the profile text manually.",
        },
        { status: 502 }
      );
    }
  }

  // Extract name / headline / location from the full text
  let name = candidate.name;
  let headline = candidate.headline;
  let location = candidate.location;

  try {
    const info = await extractCandidateInfo(profileText);
    if (info.name && info.name !== "Unknown" && info.name.length > 2) name = info.name;
    if (info.headline && info.headline.length > 2) headline = info.headline;
    if (info.location && info.location.length > 2) location = info.location;
  } catch {
    /* keep existing values */
  }

  // Score with the full profile text
  const parsedRole = safeParseJson<ParsedRole | null>(job.parsedRole, null);
  const salary =
    job.salaryMin || job.salaryMax
      ? { min: job.salaryMin ?? 0, max: job.salaryMax ?? 0 }
      : null;

  const scoreData: Record<string, unknown> = {};
  if (parsedRole) {
    try {
      const breakdown = await scoreCandidateStructured(profileText, parsedRole, salary);
      Object.assign(scoreData, deriveUpdateData(breakdown));
    } catch {
      /* keep existing scores */
    }

    if (profileText.length >= 250) {
      try {
        const acceptance = await predictAcceptance(profileText, parsedRole, salary);
        scoreData.acceptanceScore = acceptance.score;
        scoreData.acceptanceReason = JSON.stringify({
          likelihood: acceptance.likelihood,
          headline: acceptance.headline,
          signals: acceptance.signals,
          summary: acceptance.summary,
        });
      } catch {
        /* keep existing acceptance score */
      }
    }
  }

  const updated = await prisma.candidate.update({
    where: { id: candidateId },
    data: {
      name,
      headline,
      location,
      profileText,
      profileCapturedAt: new Date(),
      ...(body.success && body.data.linkedinUrl
        ? { linkedinUrl: body.data.linkedinUrl.split("?")[0] }
        : {}),
      ...scoreData,
    },
  });

  return NextResponse.json(updated);
}
