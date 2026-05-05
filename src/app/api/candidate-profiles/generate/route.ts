import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuth, unauthorized } from "@/lib/session";
import { generateProfileDocx } from "@/lib/generate-candidate-profile-doc";

export const dynamic = "force-dynamic";

const SkillGroupSchema = z.object({
  title:  z.string(),
  skills: z.array(z.string()),
});

const WorkItemSchema = z.object({
  company: z.string(),
  role:    z.string(),
  dates:   z.string().default(""),
  bullets: z.array(z.string()).default([]),
});

const QualSchema = z.object({
  institution: z.string(),
  courseYear:  z.string(),
});

const ContactSchema = z.object({
  name:  z.string().max(100).default(""),
  email: z.string().max(200).default(""),
  phone: z.string().max(50).default(""),
}).default({});

const GenerateSchema = z.object({
  candidateName:    z.string().min(1).max(200),
  targetRole:       z.string().max(200).default(""),
  dateAvailable:    z.string().max(100).default(""),
  executiveSummary: z.string().max(5000).default(""),
  skillGroups:      z.array(SkillGroupSchema).default([]),
  workHistory:      z.array(WorkItemSchema).default([]),
  qualifications:   z.array(QualSchema).default([]),
  consultant:       ContactSchema,
  manager:          ContactSchema,
});

export async function POST(req: Request) {
  try {
    const auth = await getAuth();
    if (!auth) return unauthorized();

    const result = GenerateSchema.safeParse(await req.json().catch(() => ({})));
    if (!result.success) {
      return NextResponse.json({ error: result.error.flatten() }, { status: 422 });
    }

    const { candidateName, targetRole, dateAvailable, executiveSummary,
            skillGroups, workHistory, qualifications, consultant, manager } = result.data;

    const referredDate = new Date().toLocaleDateString("en-NZ", {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
    });

    const buffer = await generateProfileDocx({
      candidateName,
      role:             targetRole,
      dateReferred:     referredDate,
      dateAvailable,
      consultant,
      manager,
      executiveSummary,
      skillGroups,
      workHistory:      workHistory.map((j) => ({
        company: j.company,
        role:    j.role,
        dates:   j.dates,
        bullets: j.bullets,
      })),
      qualifications,
    });

    const safeName = candidateName.replace(/[^a-zA-Z0-9]/g, "_");
    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${safeName}_Candidate_Profile.docx"`,
        "Content-Length": String(buffer.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("[candidate-profiles/generate]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Document generation failed" },
      { status: 500 }
    );
  }
}
