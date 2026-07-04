/**
 * Demo-org seeder — populates an isolated "Demo Agency" org with realistic NZ
 * jobs + candidates so the app can be shown POPULATED in a sales demo without
 * touching any real tenant's data.
 *
 * Safe by construction:
 *  - Runs ONLY when invoked explicitly (SEED_DEMO_ORG=1 node scripts/seed-demo-org.mjs).
 *    It is NEVER wired into the boot sequence.
 *  - Everything lands under a dedicated org (name "Demo Agency"); nothing else
 *    is read or mutated.
 *  - Idempotent: re-running upserts the same rows (unique on org name, and on
 *    (jobId, linkedinUrl) per candidate) instead of duplicating.
 *  - Candidates are seeded with profileText/headline/location but NO score —
 *    the Fit score auto-populates on first job view (the live base-score path),
 *    so the demo shows the real scoring, not a hardcoded number.
 *
 * A demo login is created only if SEED_DEMO_PASSWORD is set (else seed the data
 * and hand out an invite link from the admin page instead).
 */

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const ORG_NAME = "Demo Agency";

// Minimal-but-valid ParsedRole — only the fields the deterministic Fit scorer
// reads matter (title, location, location_rules, seniority_band, must_haves,
// nice_to_haves, skills_required/preferred). The rest are set empty/[].
function parsedRole(o) {
  return JSON.stringify({
    title: o.title,
    title_source: "explicit",
    company: o.company ?? "",
    company_source: "",
    location: o.location,
    location_source: "explicit",
    experience: o.experience ?? "",
    seniority_band: o.seniority ?? "Mid-level",
    seniority_source: "inferred",
    salary_band: o.salaryBand ?? "",
    salary_source: "",
    location_rules: o.locationRules ?? o.location,
    location_rules_source: "explicit",
    visa_flags: o.visaFlags ?? [],
    must_haves: o.mustHaves,
    nice_to_haves: o.niceToHaves ?? [],
    knockout_criteria: o.knockouts ?? [],
    application_requirements: [],
    explicitly_stated: o.mustHaves,
    strongly_inferred: [],
    search_expansion: [],
    synonym_titles: o.synonyms ?? [],
    responsibilities: [],
    search_queries: [],
    skills_required: o.mustHaves,
    skills_preferred: o.niceToHaves ?? [],
  });
}

const JOBS = [
  {
    title: "Senior Software Engineer",
    company: "Kōwhai Digital",
    location: "Wellington",
    isRemote: false,
    salaryMin: 120000,
    salaryMax: 150000,
    seniority: "Senior IC",
    locationRules: "Wellington, hybrid 2 days/week",
    mustHaves: ["React", "TypeScript", "Node.js", "5+ years commercial experience"],
    niceToHaves: ["AWS", "GraphQL", "CI/CD"],
    synonyms: ["Full-stack Developer", "Software Developer"],
    rawJd:
      "We're after a Senior Software Engineer to join our Wellington product team. You'll build customer-facing features across a React/TypeScript front end and a Node.js API, ship to AWS, and mentor two mid-level engineers. Hybrid, two days a week in the CBD office.",
    candidates: [
      { name: "Aroha Ngata", headline: "Senior Full-stack Engineer at Xero", location: "Wellington, NZ",
        profileText: "Senior Full-stack Engineer with 8 years building SaaS products. Deep React and TypeScript, Node.js APIs on AWS (Lambda, ECS), GraphQL federation, and CI/CD with GitHub Actions. Led a team of three at Xero delivering the billing platform. Wellington-based." },
      { name: "Daniel O'Sullivan", headline: "Software Engineer — React / Node", location: "Wellington, NZ",
        profileText: "Software Engineer, 6 years. Strong React and TypeScript across two product companies. Node.js/Express backends, Postgres. Some AWS exposure (S3, EC2). Keen to move into a senior role with mentoring scope. Based in Wellington, open to hybrid." },
      { name: "Mei Ling Chen", headline: "Frontend Engineer at Trade Me", location: "Wellington, NZ",
        profileText: "Frontend Engineer specialising in React and TypeScript, 4 years at Trade Me. Component libraries, accessibility, performance. Limited backend (some Node scripting). Looking to broaden into full-stack. Wellington." },
      { name: "James Whitfield", headline: "Backend Developer — Java / Spring", location: "Auckland, NZ",
        profileText: "Backend Developer, 7 years in Java and Spring Boot, Oracle and PL/SQL, on-prem and some Azure. Enterprise integration and messaging. Auckland-based, would consider relocation for the right role." },
      { name: "Priya Sharma", headline: "Full-stack Developer at BNZ", location: "Wellington, NZ",
        profileText: "Full-stack Developer, 5 years. React, TypeScript, Node.js, AWS (Lambda, DynamoDB, CloudFormation). GraphQL and REST. Delivered internal banking tools at BNZ end to end. Wellington-based, hybrid preferred." },
    ],
  },
  {
    title: "Quantity Surveyor",
    company: "Southern Cross Construction",
    location: "Auckland",
    isRemote: false,
    salaryMin: 95000,
    salaryMax: 125000,
    seniority: "Intermediate–Senior",
    locationRules: "Auckland, on-site",
    mustHaves: ["NZ construction experience", "Cost planning", "Contract administration", "NZS 3910"],
    niceToHaves: ["Revit / BIM", "Commercial fit-out", "MSTn / CostX"],
    synonyms: ["QS", "Cost Manager", "Commercial Manager"],
    rawJd:
      "Southern Cross Construction is hiring a Quantity Surveyor for our Auckland commercial team. You'll run cost planning, procurement and contract administration (NZS 3910) across mid-rise commercial builds. NZ construction experience essential; CostX and BIM familiarity a plus. On-site, Auckland.",
    candidates: [
      { name: "Tane Wiremu", headline: "Senior Quantity Surveyor at Naylor Love", location: "Auckland, NZ",
        profileText: "Senior Quantity Surveyor, 10 years NZ commercial construction. Cost planning, procurement, contract administration under NZS 3910 and 3916. CostX and MSTn. Delivered $40m+ mid-rise projects at Naylor Love. Auckland." },
      { name: "Sophie Baker", headline: "Quantity Surveyor — commercial fit-out", location: "Auckland, NZ",
        profileText: "Quantity Surveyor, 6 years, commercial fit-out and refurbishment across Auckland. NZS 3910 contract admin, monthly cost reporting, subcontractor procurement. Some Revit/BIM take-off. Looking for larger commercial builds." },
      { name: "Rajesh Patel", headline: "Cost Manager at RLB", location: "Auckland, NZ",
        profileText: "Cost Manager / QS consultant, 8 years at Rider Levett Bucknall. Feasibility, cost planning and value engineering for NZ commercial and civic projects. CostX expert. NZS 3910. Strong client-facing." },
      { name: "Emma Robertson", headline: "Graduate Quantity Surveyor", location: "Hamilton, NZ",
        profileText: "Graduate Quantity Surveyor, 1 year on residential subdivisions in the Waikato. Basic cost take-off and measurement, keen to move into commercial work and grow. Hamilton-based." },
      { name: "David Thompson", headline: "Project Manager — construction", location: "Auckland, NZ",
        profileText: "Site-based Construction Project Manager, 12 years delivering commercial builds in Auckland. Programme, subcontractor scheduling, health and safety, and stakeholder management. Civil engineering background; commercial and financial control sits with the QS team." },
    ],
  },
];

async function main() {
  if (process.env.SEED_DEMO_ORG !== "1") {
    console.error("[seed-demo] Refusing to run without SEED_DEMO_ORG=1 (this seeds demo data; never wire it into boot).");
    process.exit(1);
  }

  const org = await prisma.org.upsert({
    where: { name: ORG_NAME },
    update: {},
    create: { name: ORG_NAME },
    select: { id: true, name: true },
  });
  console.log(`[seed-demo] org "${org.name}" (${org.id})`);

  // Optional demo login.
  const demoPw = process.env.SEED_DEMO_PASSWORD;
  if (demoPw && demoPw.trim()) {
    const username = process.env.SEED_DEMO_USERNAME?.trim() || "demo";
    const existing = await prisma.user.findUnique({ where: { username } });
    if (!existing) {
      await prisma.user.create({
        data: { username, password: await bcrypt.hash(demoPw, 12), role: "user", orgId: org.id },
      });
      console.log(`[seed-demo] created demo user "${username}"`);
    } else {
      console.log(`[seed-demo] demo user "${username}" already exists — leaving as-is`);
    }
  } else {
    console.log("[seed-demo] SEED_DEMO_PASSWORD not set — skipping demo login (use an admin invite link instead)");
  }

  for (const j of JOBS) {
    // Idempotent on (orgId, title) — reuse an existing demo job of the same title.
    const existingJob = await prisma.job.findFirst({ where: { orgId: org.id, title: j.title }, select: { id: true } });
    const job = existingJob
      ? await prisma.job.update({
          where: { id: existingJob.id },
          data: {
            company: j.company, location: j.location, isRemote: j.isRemote,
            salaryMin: j.salaryMin, salaryMax: j.salaryMax, rawJd: j.rawJd,
            parsedRole: parsedRole(j), lastParsedAt: new Date(), status: "active",
          },
          select: { id: true },
        })
      : await prisma.job.create({
          data: {
            orgId: org.id, title: j.title, company: j.company, location: j.location,
            isRemote: j.isRemote, salaryMin: j.salaryMin, salaryMax: j.salaryMax,
            rawJd: j.rawJd, parsedRole: parsedRole(j), lastParsedAt: new Date(), status: "active",
          },
          select: { id: true },
        });

    let added = 0;
    for (const c of j.candidates) {
      // Synthetic stable linkedinUrl so re-runs upsert instead of duplicate
      // (matches the (jobId, linkedinUrl) unique constraint).
      const linkedinUrl = `demo:${job.id}:${c.name.toLowerCase().replace(/[^a-z]+/g, "-")}`;
      await prisma.candidate.upsert({
        where: { jobId_linkedinUrl: { jobId: job.id, linkedinUrl } },
        // Null the score fields so a changed profileText re-scores on next view
        // (the base-score path only fills candidates with matchScore null).
        update: {
          headline: c.headline, location: c.location, profileText: c.profileText,
          matchScore: null, scoreBreakdown: null, matchReason: null, profileTextHash: null,
        },
        create: {
          jobId: job.id, orgId: org.id, name: c.name, headline: c.headline,
          location: c.location, profileText: c.profileText, linkedinUrl,
          source: "manual", status: "new",
          // No score — the Fit score auto-populates on first job view.
        },
      });
      added++;
    }
    console.log(`[seed-demo] job "${j.title}" → ${added} candidates`);
  }

  console.log("[seed-demo] done. Open the Demo Agency org's jobs to see Fit scores populate.");
}

main()
  .catch((e) => {
    console.error("[seed-demo] failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
