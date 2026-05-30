/**
 * ScreeningSummary — consolidated "everything the recruiter wrote down about
 * this person" card for the candidate detail page (Phase E2).
 *
 * Tier 1: a 4-tile glance row (Salary / Availability / Notice / Visa). Always
 * rendered with a "—" fallback so the layout is stable across candidates.
 *
 * Tier 2: collapsible long-form rows beneath the tiles:
 *   - Motivations     (read-only, from screeningData.motivations)
 *   - Screening notes (read-only, from screeningData.notes)
 *   - Recruiter notes (EDITABLE — owns its own textarea + Saving/Saved chip,
 *                      driven by props from the page so the existing
 *                      auto-save-on-blur PATCH stays unchanged)
 *   - Interview notes (read-only summary parsed from candidate.interviewNotes
 *                      JSON; the full editor still lives in
 *                      <InterviewSection> on the job-context view)
 *
 * Replaces the standalone "Screening notes" + "Notes" cards on the detail
 * page so the recruiter sees one consolidated picture instead of three.
 */

"use client";

import { useState } from "react";
import {
  CalendarCheck,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  DollarSign,
  Heart,
  Loader2,
  Shield,
  StickyNote,
  type LucideIcon,
} from "lucide-react";
import { cn, safeParseJson } from "@/lib/utils";
import { Card, CardBody, CardHeader } from "@/components/ui/card";

interface ScreeningData {
  salaryExpectation?: string;
  availability?: string;
  noticePeriod?: string;
  visaStatus?: string;
  motivations?: string;
  notes?: string;
}

interface InterviewData {
  date?: string;
  interviewer?: string;
  format?: string;
  impression?: string;
  technical?: string;
  culture?: string;
  recommendation?: string;
  updatedAt?: string;
}

interface Props {
  screening: ScreeningData;
  /** Raw JSON string from Candidate.interviewNotes (or null). */
  interviewNotes: string | null;
  /** Recruiter notes — Candidate.notes. Owned by the page (state + saver). */
  notes: string;
  setNotes: (v: string) => void;
  onSaveNotes: () => void;
  notesStatus: "idle" | "saving" | "saved";
  setNotesStatus: (v: "idle" | "saving" | "saved") => void;
}

function Tile({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value?: string }) {
  return (
    <div className="rounded-md border border-separator bg-surface-sunken p-3">
      <div className="flex items-center gap-1.5 text-2xs uppercase tracking-wide text-text-tertiary">
        <Icon className="w-3 h-3" />
        <span>{label}</span>
      </div>
      <div className={cn("mt-1.5 text-sm font-medium truncate", value ? "text-text-primary" : "text-text-tertiary")}>
        {value || "—"}
      </div>
    </div>
  );
}

function ExpandableRow({
  icon: Icon,
  label,
  preview,
  defaultOpen = false,
  children,
}: {
  icon: LucideIcon;
  label: string;
  /** Short summary shown to the right of the label when collapsed. */
  preview?: string | null;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t border-separator first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 py-2.5 text-left hover:bg-surface-hover/40 -mx-4 px-4 transition-colors"
      >
        {open ? <ChevronDown className="w-3.5 h-3.5 text-text-tertiary flex-shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-text-tertiary flex-shrink-0" />}
        <Icon className="w-3.5 h-3.5 text-text-tertiary flex-shrink-0" />
        <span className="text-xs font-medium text-text-secondary w-32 flex-shrink-0">{label}</span>
        {!open && preview && (
          <span className="text-xs text-text-tertiary truncate flex-1">{preview}</span>
        )}
      </button>
      {open && <div className="pb-3 pl-7 pr-1">{children}</div>}
    </div>
  );
}

export function ScreeningSummary({
  screening,
  interviewNotes,
  notes,
  setNotes,
  onSaveNotes,
  notesStatus,
  setNotesStatus,
}: Props) {
  const interview = safeParseJson<InterviewData>(interviewNotes, {});
  const hasInterview = !!(interview.impression || interview.technical || interview.culture || interview.recommendation || interview.interviewer);

  // Build a one-line interview preview the user can scan while collapsed.
  const interviewPreview = hasInterview
    ? [interview.recommendation, interview.interviewer].filter(Boolean).join(" · ") || "captured"
    : null;

  return (
    <Card>
      <CardHeader>
        <h2 className="text-md font-semibold text-text-primary">Screening summary</h2>
      </CardHeader>
      <CardBody className="space-y-4">
        {/* 4-tile glance row. Always rendered so the card has a stable shape. */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Tile icon={DollarSign}     label="Salary"       value={screening.salaryExpectation} />
          <Tile icon={CalendarCheck}  label="Availability" value={screening.availability} />
          <Tile icon={Clock}          label="Notice"       value={screening.noticePeriod} />
          <Tile icon={Shield}         label="Visa"         value={screening.visaStatus} />
        </div>

        {/* Expandable long-form rows below the tiles. */}
        <div className="rounded-md border border-separator">
          <ExpandableRow
            icon={Heart}
            label="Motivations"
            preview={screening.motivations}
          >
            <p className="text-sm text-text-primary whitespace-pre-wrap">
              {screening.motivations || <span className="text-text-tertiary">No motivations captured.</span>}
            </p>
          </ExpandableRow>

          <ExpandableRow
            icon={StickyNote}
            label="Screening notes"
            preview={screening.notes}
          >
            <p className="text-sm text-text-primary whitespace-pre-wrap">
              {screening.notes || <span className="text-text-tertiary">No screening notes.</span>}
            </p>
          </ExpandableRow>

          {/* Recruiter notes — editable in place, defaults open so the
              recruiter doesn't have to click before typing. Preserves the
              page-level auto-save-on-blur PATCH. */}
          <ExpandableRow
            icon={StickyNote}
            label="Recruiter notes"
            preview={notes}
            defaultOpen
          >
            <div className="space-y-2">
              <textarea
                value={notes}
                onChange={(e) => { setNotes(e.target.value); setNotesStatus("idle"); }}
                onBlur={onSaveNotes}
                rows={4}
                placeholder="Add notes about this candidate…"
                className="w-full text-sm text-text-primary bg-surface-sunken border border-separator rounded px-3 py-2 placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus resize-none transition-all"
              />
              {notesStatus !== "idle" && (
                <span className={cn(
                  "text-xs flex items-center gap-1",
                  notesStatus === "saved" ? "text-success" : "text-text-tertiary",
                )}>
                  {notesStatus === "saving"
                    ? (<><Loader2 className="w-3 h-3 animate-spin" />Saving…</>)
                    : (<><Check className="w-3 h-3" />Saved</>)}
                </span>
              )}
            </div>
          </ExpandableRow>

          <ExpandableRow
            icon={StickyNote}
            label="Interview notes"
            preview={interviewPreview}
          >
            {hasInterview ? (
              <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-sm">
                {interview.recommendation && (
                  <div><dt className="text-2xs uppercase text-text-tertiary">Recommendation</dt><dd className="text-text-primary">{interview.recommendation}</dd></div>
                )}
                {interview.interviewer && (
                  <div><dt className="text-2xs uppercase text-text-tertiary">Interviewer</dt><dd className="text-text-primary">{interview.interviewer}</dd></div>
                )}
                {interview.impression && (
                  <div className="md:col-span-2"><dt className="text-2xs uppercase text-text-tertiary">Overall impression</dt><dd className="text-text-primary whitespace-pre-wrap">{interview.impression}</dd></div>
                )}
                {interview.technical && (
                  <div className="md:col-span-2"><dt className="text-2xs uppercase text-text-tertiary">Technical</dt><dd className="text-text-primary whitespace-pre-wrap">{interview.technical}</dd></div>
                )}
                {interview.culture && (
                  <div className="md:col-span-2"><dt className="text-2xs uppercase text-text-tertiary">Culture / team fit</dt><dd className="text-text-primary whitespace-pre-wrap">{interview.culture}</dd></div>
                )}
              </dl>
            ) : (
              <p className="text-sm text-text-tertiary">No interview captured yet — add one from the job-context view.</p>
            )}
          </ExpandableRow>
        </div>
      </CardBody>
    </Card>
  );
}
