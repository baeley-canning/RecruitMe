"use client";

import JSZip from "jszip";
import { useEffect, useMemo, useState } from "react";
import { Copy, FileDown, Loader2, Plus, Printer, RotateCcw, Trash2, Upload, Wand2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface PersonBlock {
  name: string;
  email: string;
  mobile: string;
}

interface ClientManager extends PersonBlock {
  id: string;
  label: string;
}

interface ProfileSettings {
  candidateManager: PersonBlock;
  clientManagers: ClientManager[];
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
  emailClient: string;
  linkedinUrl: string;
  remuneration: string;
  emailHighlights: string;
  clientManagerId: string;
  consultant?: PersonBlock;
  candidateManager?: PersonBlock;
  executiveSummary: string;
  skillGroups: SkillGroup[];
  workHistory: WorkItem[];
  educationTitle: "Qualifications" | "Certifications";
  education: EducationItem[];
}

type SourceSlot = "cv" | "interview";

interface UploadedSource {
  name: string;
  charCount: number;
}

const STORAGE_KEY = "recruitme_candidate_profile_builder_v1";
const SETTINGS_KEY = "recruitme_candidate_profile_settings_v1";
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

function blankPerson(): PersonBlock {
  return { name: "", email: "", mobile: "" };
}

function blankClientManager(label = "Client Manager"): ClientManager {
  return { id: uid(), label, ...blankPerson() };
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
  emailClient: "",
  linkedinUrl: "",
  remuneration: "",
  emailHighlights: "",
  clientManagerId: "",
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

const initialSettings: ProfileSettings = {
  candidateManager: blankPerson(),
  clientManagers: [blankClientManager("Client Manager 1"), blankClientManager("Client Manager 2")],
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

function plainText(draft: ProfileDraft, clientManager: PersonBlock, candidateManager: PersonBlock) {
  const lines = [
    "Candidate Profile",
    "",
    `Candidate: ${draft.candidate}`,
    `Role: ${draft.role}`,
    `Date Referred: ${draft.dateReferred}`,
    `Date Available: ${draft.dateAvailable}`,
    "",
    "Your Consultant:",
    clientManager.name,
    clientManager.email,
    clientManager.mobile,
    "",
    "Your Candidate Manager:",
    candidateManager.name,
    candidateManager.email,
    candidateManager.mobile,
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

function emailSubject(draft: ProfileDraft) {
  return [draft.candidate || "Candidate", draft.role || "Role"].filter(Boolean).join(" | ") + (draft.emailClient ? ` @ ${draft.emailClient}` : "");
}

function defaultEmailHighlights(draft: ProfileDraft) {
  const highlights = [
    draft.role ? `${draft.role}${draft.executiveSummary.match(/\b(?:\+?\d+)\s*\+?\s*years?/i)?.[0] ? ` with ${draft.executiveSummary.match(/\b(?:\+?\d+)\s*\+?\s*years?/i)?.[0]} of experience` : ""}` : "",
    bulletLines(draft.skillGroups.flatMap((group) => group.skills).join("\n")).slice(0, 5).join(", "),
    bulletLines(draft.workHistory.flatMap((work) => work.bullets).join("\n"))[0] ?? "",
    draft.education[0]?.course ?? "",
  ];
  return highlights.map((line) => line.trim()).filter(Boolean).slice(0, 4).join("\n");
}

function emailBody(draft: ProfileDraft) {
  const lines = [
    ...bulletLines(draft.emailHighlights || defaultEmailHighlights(draft)),
    draft.linkedinUrl.trim(),
    draft.remuneration.trim() ? `Remuneration: ${draft.remuneration.trim()}` : "",
    draft.dateAvailable.trim() ? `Availability: ${draft.dateAvailable.trim()}` : "",
  ].filter(Boolean);

  return lines.map((line) => `• ${line}`).join("\n");
}

function htmlEscape(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function xmlEscape(value: string) {
  return htmlEscape(value).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textRun(value: string, options: { bold?: boolean } = {}) {
  const safe = xmlEscape(value || " ");
  const preserve = /^\s|\s$/.test(value) ? ' xml:space="preserve"' : "";
  return `<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="20"/><w:szCs w:val="20"/>${options.bold ? "<w:b/><w:bCs/>" : ""}</w:rPr><w:t${preserve}>${safe}</w:t></w:r>`;
}

function paragraphXml(value = "", styleId = "BodyText2") {
  return `<w:p><w:pPr><w:pStyle w:val="${styleId}"/></w:pPr>${textRun(value)}</w:p>`;
}

function blankParagraphXml() {
  return "<w:p><w:pPr><w:pStyle w:val=\"BodyText2\"/></w:pPr></w:p>";
}

function pageBreakXml() {
  return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
}

function bulletParagraphXml(value: string) {
  return `<w:p><w:pPr><w:pStyle w:val="StyleAchievement12ptBefore6ptAfter6pt"/><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr>${textRun(value)}</w:p>`;
}

function boldParagraphXml(value: string) {
  return `<w:p><w:pPr><w:pStyle w:val="Institution"/></w:pPr>${textRun(value, { bold: true })}</w:p>`;
}

function replaceNthText(xml: string, target: string, replacement: string, nth: number) {
  let seen = 0;
  const targetXml = escapeRegExp(xmlEscape(target));
  return xml.replace(new RegExp(`(<w:t(?:\\s+[^>]*)?>)${targetXml}(</w:t>)`, "g"), (match, open, close) => {
    seen += 1;
    return seen === nth ? `${open}${xmlEscape(replacement)}${close}` : match;
  });
}

function replaceTextOnce(xml: string, target: string, replacement: string) {
  return replaceNthText(xml, target, replacement, 1);
}

function replaceTextSequence(xml: string, target: string, replacements: string[]) {
  let seen = 0;
  const targetXml = escapeRegExp(xmlEscape(target));
  return xml.replace(new RegExp(`(<w:t(?:\\s+[^>]*)?>)${targetXml}(</w:t>)`, "g"), (match, open, close) => {
    const replacement = replacements[seen];
    seen += 1;
    return replacement === undefined ? match : `${open}${xmlEscape(replacement)}${close}`;
  });
}

function textNodeIndex(xml: string, text: string) {
  const re = new RegExp(`<w:t(?:\\s+[^>]*)?>${escapeRegExp(xmlEscape(text))}</w:t>`);
  const match = xml.match(re);
  return match?.index ?? -1;
}

function paragraphBounds(xml: string, text: string) {
  const textIndex = textNodeIndex(xml, text);
  if (textIndex < 0) return null;
  const start = xml.lastIndexOf("<w:p", textIndex);
  const end = xml.indexOf("</w:p>", textIndex);
  if (start < 0 || end < 0) return null;
  return { start, end: end + "</w:p>".length };
}

function replaceBetweenParagraphs(xml: string, fromText: string, toText: string, insertXml: string) {
  const from = paragraphBounds(xml, fromText);
  const to = paragraphBounds(xml, toText);
  if (!from || !to || from.end > to.start) return xml;
  return `${xml.slice(0, from.end)}${insertXml}${xml.slice(to.start)}`;
}

function replaceAfterParagraphUntilSectPr(xml: string, fromText: string, insertXml: string) {
  const from = paragraphBounds(xml, fromText);
  if (!from) return xml;
  const sectStart = xml.indexOf("<w:sectPr", from.end);
  if (sectStart < 0) return xml;
  return `${xml.slice(0, from.end)}${insertXml}${xml.slice(sectStart)}`;
}

function textParagraphsXml(value: string) {
  return value
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => paragraphXml(block.replace(/\s*\n\s*/g, " ")))
    .join("");
}

function docxBodyXml(draft: ProfileDraft) {
  const skills = draft.skillGroups.filter((group) => group.title.trim() || group.skills.trim());
  const works = draft.workHistory.filter((work) => work.company.trim() || work.role.trim() || work.bullets.trim());
  const education = draft.education.filter((edu) => edu.institution.trim() || edu.course.trim() || edu.year.trim());

  const executiveXml = [
    textParagraphsXml(draft.executiveSummary),
    skills.length ? paragraphXml(`${draft.candidate || "The candidate"}'s key skills include the following:`) : "",
    ...skills.flatMap((group) => [
      group.title.trim() ? boldParagraphXml(group.title.trim()) : "",
      ...bulletLines(group.skills).map(bulletParagraphXml),
    ]),
    pageBreakXml(),
  ].join("");

  const workXml = works
    .flatMap((work) => [
      blankParagraphXml(),
      work.company.trim() ? boldParagraphXml(work.company.trim()) : "",
      [work.role, work.dates].filter(Boolean).join(", ").trim() ? paragraphXml([work.role, work.dates].filter(Boolean).join(", ")) : "",
      ...bulletLines(work.bullets).map(bulletParagraphXml),
    ])
    .join("");

  const educationXml = education
    .flatMap((edu) => [
      blankParagraphXml(),
      edu.institution.trim() ? boldParagraphXml(edu.institution.trim()) : "",
      [edu.course, edu.year].filter(Boolean).join(" | ").trim() ? paragraphXml([edu.course, edu.year].filter(Boolean).join(" | ")) : "",
    ])
    .join("");

  return { executiveXml, workXml, educationXml };
}

function safeFileName(value: string) {
  return (value || "Candidate Profile").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
}

function sourceSlotLabel(slot: SourceSlot) {
  return slot === "cv" ? "CV" : "Interview Notes";
}

function sourceSectionPattern(slot: SourceSlot) {
  return new RegExp(`\\n*--- RecruitMe Source: ${sourceSlotLabel(slot)} \\| [\\s\\S]*?--- End RecruitMe Source: ${sourceSlotLabel(slot)} ---\\n*`, "g");
}

function upsertSourceSection(current: string, slot: SourceSlot, filename: string, text: string) {
  const cleaned = current.replace(sourceSectionPattern(slot), "\n\n").trim();
  const section = `--- RecruitMe Source: ${sourceSlotLabel(slot)} | ${filename} ---\n${text.trim()}\n--- End RecruitMe Source: ${sourceSlotLabel(slot)} ---`;
  return [cleaned, section].filter(Boolean).join("\n\n").trim();
}

function removeSourceSection(current: string, slot: SourceSlot) {
  return current.replace(sourceSectionPattern(slot), "\n\n").trim();
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

function SourceUploadSlot({
  slot,
  source,
  uploading,
  disabled,
  onUpload,
  onRemove,
}: {
  slot: SourceSlot;
  source?: UploadedSource;
  uploading: boolean;
  disabled: boolean;
  onUpload: (slot: SourceSlot, file: File) => void;
  onRemove: (slot: SourceSlot) => void;
}) {
  return (
    <label className={cn(
      "flex items-center gap-3 border border-dashed rounded-lg px-4 py-3 cursor-pointer transition-colors",
      source ? "border-emerald-300 bg-emerald-50" : "border-slate-200 bg-white hover:border-blue-300 hover:bg-blue-50",
      disabled && "opacity-60 cursor-not-allowed"
    )}>
      <input
        type="file"
        accept=".pdf,.doc,.docx,.txt"
        className="sr-only"
        disabled={disabled}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onUpload(slot, file);
        }}
      />
      {uploading ? <Loader2 className="w-4 h-4 text-blue-600 animate-spin" /> : <Upload className="w-4 h-4 text-slate-500" />}
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-semibold text-slate-700">{sourceSlotLabel(slot)}</span>
        <span className="block text-xs text-slate-500 truncate">
          {uploading ? "Extracting text..." : source ? `${source.name} (${source.charCount.toLocaleString()} chars)` : "Upload PDF, Word, or TXT"}
        </span>
      </span>
      {source && (
        <button
          type="button"
          className="text-slate-400 hover:text-slate-700"
          onClick={(event) => {
            event.preventDefault();
            onRemove(slot);
          }}
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </label>
  );
}

export function CandidateProfileBuilder() {
  const [draft, setDraft] = useState<ProfileDraft>(initialDraft);
  const [settings, setSettings] = useState<ProfileSettings>(initialSettings);
  const [sourceText, setSourceText] = useState("");
  const [copied, setCopied] = useState(false);
  const [copiedEmail, setCopiedEmail] = useState<"subject" | "body" | null>(null);
  const [downloadStatus, setDownloadStatus] = useState<"idle" | "working" | "error">("idle");
  const [aiStatus, setAiStatus] = useState<"idle" | "working" | "error">("idle");
  const [discardedFacts, setDiscardedFacts] = useState(0);
  const [uploadedSources, setUploadedSources] = useState<Partial<Record<SourceSlot, UploadedSource>>>({});
  const [uploadingSlot, setUploadingSlot] = useState<SourceSlot | null>(null);
  const [uploadError, setUploadError] = useState("");

  useEffect(() => {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const rawSettings = window.localStorage.getItem(SETTINGS_KEY);
    try {
      if (raw) {
        const saved = JSON.parse(raw) as Partial<ProfileDraft>;
        setDraft({ ...initialDraft, ...saved });
      }
      if (rawSettings) {
        const savedSettings = JSON.parse(rawSettings) as Partial<ProfileSettings>;
        setSettings({
          ...initialSettings,
          ...savedSettings,
          candidateManager: { ...blankPerson(), ...savedSettings.candidateManager },
          clientManagers: savedSettings.clientManagers?.length
            ? savedSettings.clientManagers.map((manager, index) => ({ ...blankClientManager(`Client Manager ${index + 1}`), ...manager }))
            : initialSettings.clientManagers,
        });
      }
    } catch {
      window.localStorage.removeItem(STORAGE_KEY);
      window.localStorage.removeItem(SETTINGS_KEY);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
  }, [draft]);

  useEffect(() => {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    if (draft.clientManagerId || !settings.clientManagers[0]) return;
    setDraft((prev) => ({ ...prev, clientManagerId: settings.clientManagers[0].id }));
  }, [draft.clientManagerId, settings.clientManagers]);

  const selectedClientManager = useMemo(
    () => settings.clientManagers.find((manager) => manager.id === draft.clientManagerId) ?? settings.clientManagers[0] ?? blankClientManager("Client Manager"),
    [draft.clientManagerId, settings.clientManagers],
  );

  const profileText = useMemo(() => plainText(draft, selectedClientManager, settings.candidateManager), [draft, selectedClientManager, settings.candidateManager]);
  const clientEmailSubject = useMemo(() => emailSubject(draft), [draft]);
  const clientEmailBody = useMemo(() => emailBody(draft), [draft]);

  const update = <K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const updateCandidateManager = (value: PersonBlock) => setSettings((prev) => ({ ...prev, candidateManager: value }));

  const updateClientManager = (id: string, value: ClientManager) =>
    setSettings((prev) => ({ ...prev, clientManagers: prev.clientManagers.map((manager) => (manager.id === id ? value : manager)) }));

  const addClientManager = () => {
    const next = blankClientManager(`Client Manager ${settings.clientManagers.length + 1}`);
    setSettings((prev) => ({ ...prev, clientManagers: [...prev.clientManagers, next] }));
    update("clientManagerId", next.id);
  };

  const removeClientManager = (id: string) => {
    const nextManagers = settings.clientManagers.filter((manager) => manager.id !== id);
    setSettings((prev) => ({ ...prev, clientManagers: nextManagers.length ? nextManagers : [blankClientManager("Client Manager 1")] }));
    if (draft.clientManagerId === id) {
      update("clientManagerId", nextManagers[0]?.id ?? "");
    }
  };

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
<div class="label">Your Consultant:</div><div>${[selectedClientManager.name, selectedClientManager.email, selectedClientManager.mobile].filter(Boolean).map(htmlEscape).join("<br>")}</div>
<div class="label">Candidate Manager:</div><div>${[settings.candidateManager.name, settings.candidateManager.email, settings.candidateManager.mobile].filter(Boolean).map(htmlEscape).join("<br>")}</div>
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

  const uploadSourceDocument = async (slot: SourceSlot, file: File) => {
    setUploadingSlot(slot);
    setUploadError("");
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/upload", { method: "POST", body: form });
      const data = await response.json() as { text?: string; error?: string };
      if (!response.ok || !data.text?.trim()) throw new Error(data.error ?? "Could not extract text from this document");
      setSourceText((prev) => upsertSourceSection(prev, slot, file.name, data.text ?? ""));
      setUploadedSources((prev) => ({ ...prev, [slot]: { name: file.name, charCount: data.text?.trim().length ?? 0 } }));
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Could not extract text from this document");
    } finally {
      setUploadingSlot(null);
    }
  };

  const removeSourceDocument = (slot: SourceSlot) => {
    setSourceText((prev) => removeSourceSection(prev, slot));
    setUploadedSources((prev) => {
      const next = { ...prev };
      delete next[slot];
      return next;
    });
  };

  const draftWithAi = async () => {
    setAiStatus("working");
    setDiscardedFacts(0);
    try {
      const response = await fetch("/api/candidate-profiles/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceText }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Candidate profile draft failed");
      const aiDraft = data.draft as Partial<ProfileDraft> & { discardedUnsupportedFacts?: number };
      setDraft((prev) => ({
        ...prev,
        candidate: aiDraft.candidate || prev.candidate,
        role: aiDraft.role || prev.role,
        dateAvailable: aiDraft.dateAvailable || prev.dateAvailable,
        executiveSummary: aiDraft.executiveSummary || prev.executiveSummary,
        skillGroups: aiDraft.skillGroups?.length ? aiDraft.skillGroups.map((group) => ({ ...group, id: uid() })) : prev.skillGroups,
        workHistory: aiDraft.workHistory?.length ? aiDraft.workHistory.map((work) => ({ ...work, id: uid() })) : prev.workHistory,
        educationTitle: aiDraft.educationTitle || prev.educationTitle,
        education: aiDraft.education?.length ? aiDraft.education.map((edu) => ({ ...edu, id: uid() })) : prev.education,
      }));
      setDiscardedFacts(aiDraft.discardedUnsupportedFacts ?? 0);
      setAiStatus("idle");
    } catch (error) {
      console.error(error);
      setAiStatus("error");
    }
  };

  const copyProfile = async () => {
    await navigator.clipboard.writeText(profileText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const copyClientEmail = async (part: "subject" | "body") => {
    await navigator.clipboard.writeText(part === "subject" ? clientEmailSubject : clientEmailBody);
    setCopiedEmail(part);
    setTimeout(() => setCopiedEmail(null), 1800);
  };

  const downloadWordProfile = async () => {
    setDownloadStatus("working");
    try {
      const response = await fetch("/templates/CandidateProfile.dotx");
      if (!response.ok) throw new Error("Template could not be loaded");
      const zip = await JSZip.loadAsync(await response.arrayBuffer());
      const documentFile = zip.file("word/document.xml");
      if (!documentFile) throw new Error("Template document.xml is missing");

      let xml = await documentFile.async("string");
      xml = replaceTextSequence(xml, "XXXX", [draft.candidate || "XXXX", draft.role || "XXXX", draft.dateAvailable || "XXXX"]);
      xml = replaceTextOnce(xml, "Tuesday, 30 January 2024", draft.dateReferred || todayLong());
      xml = replaceTextSequence(xml, "Name", [selectedClientManager.name || "Name", settings.candidateManager.name || "Name"]);
      xml = replaceTextSequence(xml, "Email", [selectedClientManager.email || "Email", settings.candidateManager.email || "Email"]);
      xml = replaceTextSequence(xml, "Mobile number", [selectedClientManager.mobile || "Mobile number", settings.candidateManager.mobile || "Mobile number"]);
      xml = replaceTextOnce(xml, "Qualifications", draft.educationTitle);

      const { executiveXml, workXml, educationXml } = docxBodyXml(draft);
      xml = replaceBetweenParagraphs(xml, "Executive Summary", "Work History", executiveXml || pageBreakXml());
      xml = replaceBetweenParagraphs(xml, "Work History", draft.educationTitle, workXml || blankParagraphXml());
      xml = replaceAfterParagraphUntilSectPr(xml, draft.educationTitle, educationXml || blankParagraphXml());
      zip.file("word/document.xml", xml);

      const contentTypes = zip.file("[Content_Types].xml");
      if (contentTypes) {
        const contentXml = (await contentTypes.async("string")).replace(
          "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
        );
        zip.file("[Content_Types].xml", contentXml);
      }

      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${safeFileName(`${draft.candidate || "Candidate"} - ${draft.role || "Candidate Profile"}`)}.docx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setDownloadStatus("idle");
    } catch (error) {
      console.error(error);
      setDownloadStatus("error");
    }
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
          <Button onClick={downloadWordProfile} disabled={downloadStatus === "working"}>
            <FileDown className="w-4 h-4" />
            {downloadStatus === "working" ? "Building Word" : "Download Word"}
          </Button>
          <Button onClick={openPrintView}>
            <Printer className="w-4 h-4" />
            Print
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,1.05fr)_minmax(380px,0.95fr)] gap-6 items-start">
        <div className="space-y-5">
          <section className="bg-white border border-slate-200 rounded-lg shadow-sm">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">Profile Details</h2>
              <div className="flex items-center gap-3">
                <button onClick={applySource} disabled={!sourceText.trim()} className="inline-flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-700 disabled:text-slate-300">
                  <Wand2 className="w-3.5 h-3.5" />
                  Import text
                </button>
                <button onClick={draftWithAi} disabled={sourceText.trim().length < 200 || aiStatus === "working"} className="inline-flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-700 disabled:text-slate-300">
                  <Wand2 className="w-3.5 h-3.5" />
                  {aiStatus === "working" ? "Drafting" : "Draft with AI"}
                </button>
              </div>
            </div>
            <div className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <SourceUploadSlot
                  slot="cv"
                  source={uploadedSources.cv}
                  uploading={uploadingSlot === "cv"}
                  disabled={Boolean(uploadingSlot)}
                  onUpload={uploadSourceDocument}
                  onRemove={removeSourceDocument}
                />
                <SourceUploadSlot
                  slot="interview"
                  source={uploadedSources.interview}
                  uploading={uploadingSlot === "interview"}
                  disabled={Boolean(uploadingSlot)}
                  onUpload={uploadSourceDocument}
                  onRemove={removeSourceDocument}
                />
              </div>
              {uploadError && <p className="text-xs font-medium text-red-600">{uploadError}</p>}
              <TextArea label="Source text" value={sourceText} onChange={setSourceText} rows={6} placeholder="Upload CV/interview documents, paste notes, or paste a previous candidate profile. AI drafting only uses facts supported by this source text." />
              {aiStatus === "error" && <p className="text-xs font-medium text-red-600">AI drafting failed. The source text was not applied.</p>}
              {discardedFacts > 0 && <p className="text-xs font-medium text-amber-700">{discardedFacts} unsupported AI-generated fact{discardedFacts === 1 ? "" : "s"} discarded because the evidence quote was not found in the source.</p>}
              <div className="grid grid-cols-2 gap-3">
                <Field label="Candidate" value={draft.candidate} onChange={(value) => update("candidate", value)} />
                <Field label="Role" value={draft.role} onChange={(value) => update("role", value)} />
                <Field label="Date Referred" value={draft.dateReferred} onChange={(value) => update("dateReferred", value)} />
                <Field label="Date Available" value={draft.dateAvailable} onChange={(value) => update("dateAvailable", value)} />
              </div>
              <label className="block">
                <span className="block text-xs font-medium text-slate-500 mb-1">Client Manager</span>
                <select
                  value={draft.clientManagerId}
                  onChange={(event) => update("clientManagerId", event.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {settings.clientManagers.map((manager) => (
                    <option key={manager.id} value={manager.id}>
                      {manager.label || manager.name || "Client Manager"}
                    </option>
                  ))}
                </select>
              </label>
              <div className="border border-slate-200 rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-900">Client Email</h3>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" onClick={() => copyClientEmail("subject")}>
                      <Copy className="w-3.5 h-3.5" />
                      {copiedEmail === "subject" ? "Copied" : "Subject"}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => copyClientEmail("body")}>
                      <Copy className="w-3.5 h-3.5" />
                      {copiedEmail === "body" ? "Copied" : "Body"}
                    </Button>
                  </div>
                </div>
                <div className="p-4 space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Client / company for subject" value={draft.emailClient} onChange={(value) => update("emailClient", value)} placeholder="Co-operative Bank" />
                    <Field label="LinkedIn URL" value={draft.linkedinUrl} onChange={(value) => update("linkedinUrl", value)} placeholder="https://www.linkedin.com/in/..." />
                    <Field label="Remuneration" value={draft.remuneration} onChange={(value) => update("remuneration", value)} placeholder="$154,000 per annum" />
                    <Field label="Availability" value={draft.dateAvailable} onChange={(value) => update("dateAvailable", value)} placeholder="Four weeks from offer" />
                  </div>
                  <TextArea
                    label="Email highlights"
                    value={draft.emailHighlights}
                    onChange={(value) => update("emailHighlights", value)}
                    rows={4}
                    placeholder="One highlight per line. Leave blank to use a basic draft from the profile fields."
                  />
                  <div className="border border-slate-200 rounded-lg overflow-hidden">
                    <div className="px-4 py-3 border-b border-slate-100 bg-white">
                      <p className="text-xs font-medium text-slate-500">Subject</p>
                      <p className="text-sm font-semibold text-slate-900">{clientEmailSubject}</p>
                    </div>
                    <div className="px-4 py-3 bg-white">
                      <ul className="list-disc pl-5 text-sm text-slate-800 leading-7">
                        {clientEmailBody.split("\n").map((line) => line.replace(/^•\s*/, "")).filter(Boolean).map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="bg-white border border-slate-200 rounded-lg shadow-sm">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">People Settings</h2>
              <Button size="sm" variant="outline" onClick={addClientManager}>
                <Plus className="w-3.5 h-3.5" />
                Manager
              </Button>
            </div>
            <div className="p-5 space-y-5">
              <div className="space-y-3">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Your Candidate Manager</p>
                <div className="grid grid-cols-3 gap-3">
                  <Field label="Name" value={settings.candidateManager.name} onChange={(value) => updateCandidateManager({ ...settings.candidateManager, name: value })} />
                  <Field label="Email" value={settings.candidateManager.email} onChange={(value) => updateCandidateManager({ ...settings.candidateManager, email: value })} />
                  <Field label="Mobile" value={settings.candidateManager.mobile} onChange={(value) => updateCandidateManager({ ...settings.candidateManager, mobile: value })} />
                </div>
              </div>

              <div className="space-y-4">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Client Managers</p>
                {settings.clientManagers.map((manager) => (
                  <div key={manager.id} className="border border-slate-200 rounded-lg p-4">
                    <div className="grid grid-cols-[160px_1fr_1fr_150px_32px] gap-3">
                      <Field label="Dropdown label" value={manager.label} onChange={(value) => updateClientManager(manager.id, { ...manager, label: value })} />
                      <Field label="Name" value={manager.name} onChange={(value) => updateClientManager(manager.id, { ...manager, name: value })} />
                      <Field label="Email" value={manager.email} onChange={(value) => updateClientManager(manager.id, { ...manager, email: value })} />
                      <Field label="Mobile" value={manager.mobile} onChange={(value) => updateClientManager(manager.id, { ...manager, mobile: value })} />
                      <button className="mt-6 text-slate-400 hover:text-red-600" onClick={() => removeClientManager(manager.id)}>
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              {downloadStatus === "error" && <p className="text-xs font-medium text-red-600">The Word template could not be generated. Check the template file and try again.</p>}
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
                <strong>Consultant:</strong><span>{[selectedClientManager.name, selectedClientManager.email, selectedClientManager.mobile].filter(Boolean).join(" | ") || "Name | Email | Mobile"}</span>
                <strong>Manager:</strong><span>{[settings.candidateManager.name, settings.candidateManager.email, settings.candidateManager.mobile].filter(Boolean).join(" | ") || "Name | Email | Mobile"}</span>
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
