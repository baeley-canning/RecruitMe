"use client";

import { useEffect, useMemo, useState } from "react";
import { Copy, FileDown, Plus, Printer, RotateCcw, Trash2, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface PersonBlock {
  name: string;
  email: string;
  mobile: string;
}

interface WorkItem {
  id: string;
  company: string;
  role: string;
  dates: string;
  bullets: string;
}

interface EducationItem {
  id: string;
  institution: string;
  course: string;
  year: string;
}

interface SkillGroup {
  id: string;
  title: string;
  skills: string;
}

interface ProfileDraft {
  candidate: string;
  role: string;
  dateReferred: string;
  dateAvailable: string;
  consultant: PersonBlock;
  candidateManager: PersonBlock;
  executiveSummary: string;
  skillGroups: SkillGroup[];
  workHistory: WorkItem[];
  educationTitle: "Qualifications" | "Certifications";
  education: EducationItem[];
}

const STORAGE_KEY = "recruitme_candidate_profile_builder_v1";
const TERMS_TEXT =
  "Interview of candidates referred by placeMe Recruitment Ltd. shall be deemed acceptance of our standard terms of business or agreed terms of business and agreement to pay the relevant agency fee for such candidates employed by the organisation to whom the referral was made or any other organisation or person associated with it.";

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function blankWork(): WorkItem {
  return { id: uid(), company: "", role: "", dates: "", bullets: "" };
}

function blankEducation(): EducationItem {
  return { id: uid(), institution: "", course: "", year: "" };
}

function blankSkillGroup(title = ""): SkillGroup {
  return { id: uid(), title, skills: "" };
}

function todayLong() {
  return new Intl.DateTimeFormat("en-NZ", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date());
}

const initialDraft: ProfileDraft = {
  candidate: "",
  role: "",
  dateReferred: todayLong(),
  dateAvailable: "",
  consultant: { name: "", email: "", mobile: "" },
  candidateManager: { name: "", email: "", mobile: "" },
  executiveSummary: "",
  skillGroups: [
    blankSkillGroup("Data Platforms & Warehousing"),
    blankSkillGroup("ETL & Data Integration"),
    blankSkillGroup("Analytics & Reporting"),
  ],
  workHistory: [blankWork()],
  educationTitle: "Qualifications",
  education: [blankEducation()],
};

function splitLines(value: string) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function bulletLines(value: string) {
  return splitLines(value).map((line) => line.replace(/^[-*•]\s*/, ""));
}

function section(text: string, heading: string, next: string[]) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nextPattern = next.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(`${escaped}\\s*([\\s\\S]*?)(?=${nextPattern ? `\\n(?:${nextPattern})\\b` : "$"}|$)`, "i");
  return text.match(re)?.[1]?.trim() ?? "";
}

function parsePopulatedProfile(text: string): Partial<ProfileDraft> {
  const lines = splitLines(text);
  const getAfter = (label: string) => lines.find((line) => line.toLowerCase().startsWith(label.toLowerCase()))?.replace(new RegExp(`^${label}\\s*:?\\s*`, "i"), "").trim() ?? "";
  const executiveSummary = section(text, "Executive Summary", ["Work History", "Qualifications", "Certifications"]);
  const workText = section(text, "Work History", ["Qualifications", "Certifications"]);
  const educationTitle = /\nCertifications\b/i.test(text) ? "Certifications" : "Qualifications";
  const educationText = section(text, educationTitle, []);

  const workBlocks = workText
    .split(/\n(?=[A-Z][^\n]{2,80}\n[A-Z][^\n]{2,100},?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d{4}))/)
    .map((block) => block.trim())
    .filter(Boolean);

  const workHistory = workBlocks.map((block) => {
    const blockLines = splitLines(block);
    return {
      id: uid(),
      company: blockLines[0] ?? "",
      role: (blockLines[1] ?? "").replace(/,\s*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec).*)$/i, ""),
      dates: blockLines[1]?.match(/,\s*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec).*)$/i)?.[1] ?? "",
      bullets: blockLines.slice(2).map((line) => line.replace(/^[-*•]\s*/, "")).join("\n"),
    };
  });

  return {
    candidate: getAfter("Candidate"),
    role: getAfter("Role"),
    dateReferred: getAfter("Date Referred"),
    dateAvailable: getAfter("Date Available"),
    executiveSummary,
    workHistory: workHistory.length ? workHistory : undefined,
    educationTitle,
    education: educationText ? [{ id: uid(), institution: "", course: educationText, year: "" }] : undefined,
  };
}

function plainText(draft: ProfileDraft) {
  const lines = [
    "Candidate Profile",
    "",
    `Candidate: ${draft.candidate}`,
    `Role: ${draft.role}`,
    `Date Referred: ${draft.dateReferred}`,
    `Date Available: ${draft.dateAvailable}`,
    "",
    "Your Consultant:",
    draft.consultant.name,
    draft.consultant.email,
    draft.consultant.mobile,
    "",
    "Your Candidate Manager:",
    draft.candidateManager.name,
    draft.candidateManager.email,
    draft.candidateManager.mobile,
    "",
    TERMS_TEXT,
    "",
    "Executive Summary",
    draft.executiveSummary,
  ];

  const filledSkillGroups = draft.skillGroups.filter((group) => group.title.trim() || group.skills.trim());
  if (filledSkillGroups.length) {
    lines.push("", `${draft.candidate || "The candidate"}'s key skills include the following:`);
    for (const group of filledSkillGroups) {
      lines.push(group.title);
      lines.push(...bulletLines(group.skills).map((skill) => `- ${skill}`));
    }
  }

  lines.push("", "Work History");
  for (const item of draft.workHistory.filter((work) => work.company || work.role || work.bullets)) {
    lines.push("", item.company, [item.role, item.dates].filter(Boolean).join(", "));
    lines.push(...bulletLines(item.bullets).map((bullet) => `- ${bullet}`));
  }

  lines.push("", draft.educationTitle);
  for (const item of draft.education.filter((edu) => edu.institution || edu.course || edu.year)) {
    lines.push("", item.institution, [item.course, item.year].filter(Boolean).join(" | "));
  }

  return lines.filter((line, index, arr) => line || arr[index - 1] !== "").join("\n").trim();
}

function htmlEscape(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-slate-500 mb-1">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    </label>
  );
}

function TextArea({ label, value, onChange, rows = 5, placeholder }: { label: string; value: string; onChange: (value: string) => void; rows?: number; placeholder?: string }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-slate-500 mb-1">{label}</span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={rows}
        placeholder={placeholder}
        className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y leading-relaxed"
      />
    </label>
  );
}

export function CandidateProfileBuilder() {
  const [draft, setDraft] = useState<ProfileDraft>(initialDraft);
  const [sourceText, setSourceText] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      setDraft({ ...initialDraft, ...JSON.parse(raw) });
    } catch {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
  }, [draft]);

  const profileText = useMemo(() => plainText(draft), [draft]);

  const update = <K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const openPrintView = () => {
    const win = window.open("", "_blank");
    if (!win) return;
    const skills = draft.skillGroups.filter((group) => group.title || group.skills);
    const works = draft.workHistory.filter((work) => work.company || work.role || work.bullets);
    const education = draft.education.filter((edu) => edu.institution || edu.course || edu.year);
    win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${htmlEscape(draft.candidate || "Candidate Profile")}</title>
<style>
body{font-family:Arial,sans-serif;color:#1f2937;max-width:760px;margin:40px auto;line-height:1.55;font-size:14px}
h1{font-size:28px;margin:0 0 28px;text-align:center}h2{font-size:18px;margin:30px 0 10px;border-bottom:1px solid #e5e7eb;padding-bottom:6px}
.meta{display:grid;grid-template-columns:150px 1fr;gap:7px 14px;margin-bottom:20px}.label{font-weight:700;color:#475569}
.terms{font-size:11px;color:#475569;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;padding:12px 0;margin:22px 0}
ul{margin:6px 0 12px 18px;padding:0}.role{font-weight:700}.date{color:#64748b}.block{margin-bottom:18px}
@media print{body{margin:20px auto}.no-print{display:none}}
</style></head><body>
<h1>Candidate Profile</h1>
<div class="meta">
<div class="label">Candidate:</div><div>${htmlEscape(draft.candidate)}</div>
<div class="label">Role:</div><div>${htmlEscape(draft.role)}</div>
<div class="label">Date Referred:</div><div>${htmlEscape(draft.dateReferred)}</div>
<div class="label">Date Available:</div><div>${htmlEscape(draft.dateAvailable)}</div>
<div class="label">Your Consultant:</div><div>${[draft.consultant.name, draft.consultant.email, draft.consultant.mobile].filter(Boolean).map(htmlEscape).join("<br>")}</div>
<div class="label">Candidate Manager:</div><div>${[draft.candidateManager.name, draft.candidateManager.email, draft.candidateManager.mobile].filter(Boolean).map(htmlEscape).join("<br>")}</div>
</div>
<div class="terms">${htmlEscape(TERMS_TEXT)}</div>
<h2>Executive Summary</h2><p>${htmlEscape(draft.executiveSummary).replace(/\n/g, "<br>")}</p>
${skills.length ? `<p><strong>${htmlEscape(draft.candidate || "The candidate")}'s key skills include the following:</strong></p>${skills.map((group) => `<div class="block"><div class="role">${htmlEscape(group.title)}</div><ul>${bulletLines(group.skills).map((skill) => `<li>${htmlEscape(skill)}</li>`).join("")}</ul></div>`).join("")}` : ""}
<h2>Work History</h2>${works.map((work) => `<div class="block"><div class="role">${htmlEscape(work.company)}</div><div>${htmlEscape(work.role)} <span class="date">${htmlEscape(work.dates)}</span></div><ul>${bulletLines(work.bullets).map((bullet) => `<li>${htmlEscape(bullet)}</li>`).join("")}</ul></div>`).join("")}
<h2>${htmlEscape(draft.educationTitle)}</h2>${education.map((edu) => `<div class="block"><div class="role">${htmlEscape(edu.institution)}</div><div>${htmlEscape([edu.course, edu.year].filter(Boolean).join(" | "))}</div></div>`).join("")}
</body></html>`);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 300);
  };

  const applySource = () => {
    const parsed = parsePopulatedProfile(sourceText);
    setDraft((prev) => ({ ...prev, ...parsed }));
  };

  const copyProfile = async () => {
    await navigator.clipboard.writeText(profileText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="flex items-start justify-between gap-5 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Candidate Profiles</h1>
          <p className="text-sm text-slate-500 mt-1">Build placeMe candidate profile drafts from interview notes, CV text, or an existing profile.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setDraft(initialDraft)}>
            <RotateCcw className="w-4 h-4" />
            Reset
          </Button>
          <Button variant="outline" onClick={copyProfile}>
            <Copy className="w-4 h-4" />
            {copied ? "Copied" : "Copy text"}
          </Button>
          <Button onClick={openPrintView}>
            <Printer className="w-4 h-4" />
            Print/PDF
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,1.05fr)_minmax(380px,0.95fr)] gap-6 items-start">
        <div className="space-y-5">
          <section className="bg-white border border-slate-200 rounded-lg shadow-sm">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">Profile Details</h2>
              <button onClick={applySource} disabled={!sourceText.trim()} className="inline-flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-700 disabled:text-slate-300">
                <Wand2 className="w-3.5 h-3.5" />
                Import text
              </button>
            </div>
            <div className="p-5 space-y-4">
              <TextArea label="Paste completed profile text" value={sourceText} onChange={setSourceText} rows={4} placeholder="Paste a previous candidate profile to prefill the builder." />
              <div className="grid grid-cols-2 gap-3">
                <Field label="Candidate" value={draft.candidate} onChange={(value) => update("candidate", value)} />
                <Field label="Role" value={draft.role} onChange={(value) => update("role", value)} />
                <Field label="Date Referred" value={draft.dateReferred} onChange={(value) => update("dateReferred", value)} />
                <Field label="Date Available" value={draft.dateAvailable} onChange={(value) => update("dateAvailable", value)} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                {(["consultant", "candidateManager"] as const).map((key) => (
                  <div key={key} className="space-y-2">
                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{key === "consultant" ? "Consultant" : "Candidate Manager"}</p>
                    <Field label="Name" value={draft[key].name} onChange={(value) => update(key, { ...draft[key], name: value })} />
                    <Field label="Email" value={draft[key].email} onChange={(value) => update(key, { ...draft[key], email: value })} />
                    <Field label="Mobile" value={draft[key].mobile} onChange={(value) => update(key, { ...draft[key], mobile: value })} />
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="bg-white border border-slate-200 rounded-lg shadow-sm p-5">
            <TextArea label="Executive Summary" value={draft.executiveSummary} onChange={(value) => update("executiveSummary", value)} rows={9} placeholder="Write the client-ready overview, motivations, relevant strengths, and role fit." />
          </section>

          <section className="bg-white border border-slate-200 rounded-lg shadow-sm">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">Key Skills</h2>
              <Button size="sm" variant="outline" onClick={() => update("skillGroups", [...draft.skillGroups, blankSkillGroup()])}>
                <Plus className="w-3.5 h-3.5" />
                Group
              </Button>
            </div>
            <div className="p-5 space-y-4">
              {draft.skillGroups.map((group, index) => (
                <div key={group.id} className="grid grid-cols-[220px_minmax(0,1fr)_32px] gap-3">
                  <Field label="Group" value={group.title} onChange={(value) => {
                    const next = [...draft.skillGroups]; next[index] = { ...group, title: value }; update("skillGroups", next);
                  }} />
                  <TextArea label="Skills" value={group.skills} rows={2} onChange={(value) => {
                    const next = [...draft.skillGroups]; next[index] = { ...group, skills: value }; update("skillGroups", next);
                  }} placeholder="One per line" />
                  <button className="mt-6 text-slate-400 hover:text-red-600" onClick={() => update("skillGroups", draft.skillGroups.filter((item) => item.id !== group.id))}>
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          </section>

          <section className="bg-white border border-slate-200 rounded-lg shadow-sm">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">Work History</h2>
              <Button size="sm" variant="outline" onClick={() => update("workHistory", [...draft.workHistory, blankWork()])}>
                <Plus className="w-3.5 h-3.5" />
                Role
              </Button>
            </div>
            <div className="p-5 space-y-5">
              {draft.workHistory.map((work, index) => (
                <div key={work.id} className="border border-slate-200 rounded-lg p-4 space-y-3">
                  <div className="grid grid-cols-[1fr_1fr_180px_32px] gap-3">
                    <Field label="Company" value={work.company} onChange={(value) => {
                      const next = [...draft.workHistory]; next[index] = { ...work, company: value }; update("workHistory", next);
                    }} />
                    <Field label="Role" value={work.role} onChange={(value) => {
                      const next = [...draft.workHistory]; next[index] = { ...work, role: value }; update("workHistory", next);
                    }} />
                    <Field label="Dates" value={work.dates} onChange={(value) => {
                      const next = [...draft.workHistory]; next[index] = { ...work, dates: value }; update("workHistory", next);
                    }} />
                    <button className="mt-6 text-slate-400 hover:text-red-600" onClick={() => update("workHistory", draft.workHistory.filter((item) => item.id !== work.id))}>
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                  <TextArea label="Achievements / responsibilities" value={work.bullets} rows={4} onChange={(value) => {
                    const next = [...draft.workHistory]; next[index] = { ...work, bullets: value }; update("workHistory", next);
                  }} placeholder="One bullet per line" />
                </div>
              ))}
            </div>
          </section>

          <section className="bg-white border border-slate-200 rounded-lg shadow-sm">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
              <select value={draft.educationTitle} onChange={(event) => update("educationTitle", event.target.value as ProfileDraft["educationTitle"])} className="text-sm font-semibold text-slate-900 bg-transparent focus:outline-none">
                <option>Qualifications</option>
                <option>Certifications</option>
              </select>
              <Button size="sm" variant="outline" onClick={() => update("education", [...draft.education, blankEducation()])}>
                <Plus className="w-3.5 h-3.5" />
                Item
              </Button>
            </div>
            <div className="p-5 space-y-3">
              {draft.education.map((edu, index) => (
                <div key={edu.id} className="grid grid-cols-[1fr_1fr_120px_32px] gap-3">
                  <Field label="Institution" value={edu.institution} onChange={(value) => {
                    const next = [...draft.education]; next[index] = { ...edu, institution: value }; update("education", next);
                  }} />
                  <Field label="Course / certification" value={edu.course} onChange={(value) => {
                    const next = [...draft.education]; next[index] = { ...edu, course: value }; update("education", next);
                  }} />
                  <Field label="Year" value={edu.year} onChange={(value) => {
                    const next = [...draft.education]; next[index] = { ...edu, year: value }; update("education", next);
                  }} />
                  <button className="mt-6 text-slate-400 hover:text-red-600" onClick={() => update("education", draft.education.filter((item) => item.id !== edu.id))}>
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          </section>
        </div>

        <aside className="sticky top-6 bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">Preview</h2>
            <FileDown className="w-4 h-4 text-slate-400" />
          </div>
          <div className="p-6 max-h-[calc(100vh-120px)] overflow-y-auto">
            <div className="prose prose-sm max-w-none">
              <h1 className="text-center text-2xl font-bold text-slate-900 mb-6">Candidate Profile</h1>
              <div className="grid grid-cols-[130px_1fr] gap-x-4 gap-y-1 text-sm">
                <strong>Candidate:</strong><span>{draft.candidate || "XXXX"}</span>
                <strong>Role:</strong><span>{draft.role || "XXXX"}</span>
                <strong>Date Referred:</strong><span>{draft.dateReferred}</span>
                <strong>Date Available:</strong><span>{draft.dateAvailable || "XXXX"}</span>
                <strong>Consultant:</strong><span>{[draft.consultant.name, draft.consultant.email, draft.consultant.mobile].filter(Boolean).join(" | ") || "Name | Email | Mobile"}</span>
                <strong>Manager:</strong><span>{[draft.candidateManager.name, draft.candidateManager.email, draft.candidateManager.mobile].filter(Boolean).join(" | ") || "Name | Email | Mobile"}</span>
              </div>
              <p className="my-5 py-3 border-y border-slate-200 text-[11px] leading-relaxed text-slate-500">{TERMS_TEXT}</p>
              <h2 className="text-lg font-semibold text-slate-900 mt-6">Executive Summary</h2>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{draft.executiveSummary || "Executive summary will appear here."}</p>
              {draft.skillGroups.some((group) => group.title || group.skills) && (
                <>
                  <p className="text-sm font-medium text-slate-800">{draft.candidate || "The candidate"}&apos;s key skills include the following:</p>
                  {draft.skillGroups.filter((group) => group.title || group.skills).map((group) => (
                    <div key={group.id} className="mb-3">
                      <h3 className="text-sm font-semibold text-slate-900">{group.title}</h3>
                      <ul className="list-disc pl-5 text-sm text-slate-700">{bulletLines(group.skills).map((skill) => <li key={skill}>{skill}</li>)}</ul>
                    </div>
                  ))}
                </>
              )}
              <h2 className="text-lg font-semibold text-slate-900 mt-6">Work History</h2>
              {draft.workHistory.filter((work) => work.company || work.role || work.bullets).map((work) => (
                <div key={work.id} className="mb-4">
                  <h3 className="text-sm font-semibold text-slate-900">{work.company}</h3>
                  <p className="text-sm text-slate-600">{[work.role, work.dates].filter(Boolean).join(", ")}</p>
                  <ul className="list-disc pl-5 text-sm text-slate-700">{bulletLines(work.bullets).map((bullet) => <li key={bullet}>{bullet}</li>)}</ul>
                </div>
              ))}
              <h2 className="text-lg font-semibold text-slate-900 mt-6">{draft.educationTitle}</h2>
              {draft.education.filter((edu) => edu.institution || edu.course || edu.year).map((edu) => (
                <div key={edu.id} className={cn("mb-3", !edu.institution && "text-slate-700")}>
                  {edu.institution && <h3 className="text-sm font-semibold text-slate-900">{edu.institution}</h3>}
                  <p className="text-sm">{[edu.course, edu.year].filter(Boolean).join(" | ")}</p>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
