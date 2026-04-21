import { NextResponse } from "next/server";
import { z } from "zod";
import { generateJobAd, parseJobDescription } from "@/lib/ai";
import { getAuth, unauthorized } from "@/lib/session";

const DraftSchema = z.object({
  title: z.string().trim().min(1, "Job title is required"),
  company: z.string().trim().optional().default(""),
  location: z.string().trim().optional().default(""),
  isRemote: z.boolean().optional().default(false),
  salaryMin: z.number().nullable().optional(),
  salaryMax: z.number().nullable().optional(),
  brief: z.string().trim().min(40, "Add a rough brief first so AI has enough context"),
});

function formatSalary(min?: number | null, max?: number | null) {
  if (min && max) return `$${Math.round(min / 1000)}k-$${Math.round(max / 1000)}k NZD`;
  if (min) return `From $${Math.round(min / 1000)}k NZD`;
  if (max) return `Up to $${Math.round(max / 1000)}k NZD`;
  return "";
}

export async function POST(req: Request) {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const parsed = DraftSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0]?.message ?? "Invalid listing draft request";
    return NextResponse.json({ error: firstIssue }, { status: 422 });
  }

  const { title, company, location, isRemote, salaryMin, salaryMax, brief } = parsed.data;

  const seedBrief = [
    `Role title: ${title}`,
    company ? `Company: ${company}` : "",
    location ? `Location: ${location}` : "",
    isRemote ? "Remote policy: Remote role or flexible remote arrangement" : "",
    formatSalary(salaryMin, salaryMax) ? `Salary: ${formatSalary(salaryMin, salaryMax)}` : "",
    "",
    "Hiring brief / notes:",
    brief,
  ]
    .filter(Boolean)
    .join("\n");

  const parsedRole = await parseJobDescription(seedBrief);
  const explicitSalaryBand = formatSalary(salaryMin, salaryMax);
  const explicitLocationRules = isRemote
    ? [location || parsedRole.location, "Remote / flexible"]
        .filter(Boolean)
        .join(" - ")
    : !parsedRole.location_rules && location
      ? location
      : "";

  const hydratedRole = {
    ...parsedRole,
    title: title || parsedRole.title,
    title_source: title ? "explicit" : parsedRole.title_source,
    company: company || parsedRole.company,
    company_source: company ? "explicit" : parsedRole.company_source,
    location: location || parsedRole.location,
    location_source: location ? "explicit" : parsedRole.location_source,
    location_rules: explicitLocationRules || parsedRole.location_rules || location || parsedRole.location,
    location_rules_source: explicitLocationRules ? "explicit" : parsedRole.location_rules_source,
    salary_band: explicitSalaryBand || parsedRole.salary_band,
    salary_source: explicitSalaryBand ? "explicit" : parsedRole.salary_source,
  };

  const ad = await generateJobAd(hydratedRole, company || parsedRole.company, seedBrief);

  return NextResponse.json({
    headline: ad.headline,
    body: ad.body,
    parsedRole: hydratedRole,
  });
}
