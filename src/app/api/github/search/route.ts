import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuth, unauthorized } from "@/lib/session";
import { searchGitHubDevelopers } from "@/lib/github-search";

const QuerySchema = z.object({
  location:  z.string().min(1).max(100).default("New Zealand"),
  languages: z.string().optional(), // comma-separated
  max:       z.coerce.number().int().min(1).max(30).default(20),
});

export async function GET(req: Request) {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const url    = new URL(req.url);
  const parsed = QuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });
  }

  const { location, languages: langsRaw, max } = parsed.data;
  const languages = langsRaw
    ? langsRaw.split(",").map((l) => l.trim()).filter(Boolean)
    : [];

  try {
    const result = await searchGitHubDevelopers({ location, languages, maxResults: max });
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "GitHub search failed";
    const status = msg.includes("rate limit") ? 429 : 502;
    return NextResponse.json({ error: msg }, { status });
  }
}
