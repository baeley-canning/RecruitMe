"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  ChevronDown, ChevronUp, UserCheck, Plus, Sparkles,
  Loader2, X, CheckCircle2, ChevronRight,
} from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { cn, safeParseJson } from "@/lib/utils";

interface ReferenceQuestion {
  question: string;
  category: string;
}

interface ReferenceResponse {
  question: string;
  answer: string;
}

interface ReferenceCheck {
  id: string;
  refereeName: string;
  refereeTitle: string | null;
  refereeCompany: string | null;
  refereeEmail: string | null;
  refereePhone: string | null;
  relationship: string | null;
  status: string;
  questions: string | null;
  responses: string | null;
  summary: string | null;
  createdAt: string;
}

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  contacted: "Contacted",
  received: "Received",
  complete: "Complete",
};

// Status colour tokens — keep these aligned with the global status palette so
// "received" is amber/attention, "complete" is success, etc.
const STATUS_COLORS: Record<string, string> = {
  pending:   "bg-surface-hover text-text-secondary",
  contacted: "bg-accent-subtle text-accent",
  received:  "bg-warning-subtle text-warning",
  complete:  "bg-success-subtle text-success",
};

interface ReferencePanelProps {
  candidateId: string;
  jobId: string;
}

export function ReferencePanel({ candidateId, jobId }: ReferencePanelProps) {
  const [open, setOpen] = useState(false);
  const [refs, setRefs] = useState<ReferenceCheck[]>([]);
  const [loading, setLoading] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [expandedRef, setExpandedRef] = useState<string | null>(null);
  const [generatingQuestions, setGeneratingQuestions] = useState<string | null>(null);
  const [summarising, setSummarising] = useState<string | null>(null);
  const [deletingRef, setDeletingRef] = useState<string | null>(null);
  const fetchedRef = useRef(false);

  const [newRef, setNewRef] = useState({
    refereeName: "", refereeTitle: "", refereeCompany: "",
    refereeEmail: "", refereePhone: "", relationship: "",
  });

  const fetchRefs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/candidates/${candidateId}/references`);
      if (res.ok) setRefs(await res.json() as ReferenceCheck[]);
    } finally {
      setLoading(false);
    }
  }, [candidateId, jobId]);

  useEffect(() => {
    if (open && !fetchedRef.current) {
      fetchedRef.current = true;
      fetchRefs();
    }
  }, [open, fetchRefs]);

  const handleAddRef = async () => {
    if (!newRef.refereeName.trim()) return;
    const res = await fetch(`/api/jobs/${jobId}/candidates/${candidateId}/references`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newRef),
    });
    if (res.ok) {
      const created = await res.json() as ReferenceCheck;
      setRefs((r) => [...r, created]);
      setNewRef({ refereeName: "", refereeTitle: "", refereeCompany: "", refereeEmail: "", refereePhone: "", relationship: "" });
      setAddOpen(false);
    }
  };

  const handleDelete = async (refId: string) => {
    setDeletingRef(refId);
    try {
      await fetch(`/api/jobs/${jobId}/candidates/${candidateId}/references/${refId}`, { method: "DELETE" });
      setRefs((r) => r.filter((x) => x.id !== refId));
      if (expandedRef === refId) setExpandedRef(null);
    } finally {
      setDeletingRef(null);
    }
  };

  const handleGenerateQuestions = async (refId: string) => {
    setGeneratingQuestions(refId);
    try {
      const res = await fetch(
        `/api/jobs/${jobId}/candidates/${candidateId}/references/${refId}/questions`,
        { method: "POST" }
      );
      if (res.ok) {
        const updated = await res.json() as ReferenceCheck;
        setRefs((r) => r.map((x) => x.id === refId ? updated : x));
      }
    } finally {
      setGeneratingQuestions(null);
    }
  };

  const handleStatusChange = async (refId: string, status: string) => {
    const res = await fetch(`/api/jobs/${jobId}/candidates/${candidateId}/references/${refId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (res.ok) {
      const updated = await res.json() as ReferenceCheck;
      setRefs((r) => r.map((x) => x.id === refId ? updated : x));
    }
  };

  const handleSaveAnswers = async (refId: string, responses: ReferenceResponse[]) => {
    const res = await fetch(`/api/jobs/${jobId}/candidates/${candidateId}/references/${refId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ responses: JSON.stringify(responses), status: "received" }),
    });
    if (res.ok) {
      const updated = await res.json() as ReferenceCheck;
      setRefs((r) => r.map((x) => x.id === refId ? updated : x));
    }
  };

  const handleSummarise = async (refId: string) => {
    setSummarising(refId);
    try {
      const res = await fetch(
        `/api/jobs/${jobId}/candidates/${candidateId}/references/${refId}/summarise`,
        { method: "POST" }
      );
      if (res.ok) {
        const updated = await res.json() as ReferenceCheck;
        setRefs((r) => r.map((x) => x.id === refId ? updated : x));
      }
    } finally {
      setSummarising(null);
    }
  };

  const completeCount = refs.filter((r) => r.status === "complete").length;

  return (
    <div className="rounded-md border border-separator bg-surface-raised overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-surface-hover transition-colors"
      >
        <div className="flex items-center gap-2">
          <UserCheck className="w-3.5 h-3.5 text-text-tertiary" />
          <span className="text-md font-medium text-text-primary">Reference checks</span>
          {refs.length > 0 && (
            <Badge className="data-mono">
              {completeCount}/{refs.length}
            </Badge>
          )}
        </div>
        {open
          ? <ChevronUp className="w-3.5 h-3.5 text-text-tertiary" />
          : <ChevronDown className="w-3.5 h-3.5 text-text-tertiary" />}
      </button>

      {open && (
        <div className="p-3 space-y-2.5 border-t border-separator">
          {loading && (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="w-4 h-4 animate-spin text-text-tertiary" />
            </div>
          )}

          {refs.map((ref) => (
            <RefCard
              key={ref.id}
              ref_={ref}
              expanded={expandedRef === ref.id}
              onToggle={() => setExpandedRef(expandedRef === ref.id ? null : ref.id)}
              onDelete={() => handleDelete(ref.id)}
              onGenerateQuestions={() => handleGenerateQuestions(ref.id)}
              onStatusChange={(status) => handleStatusChange(ref.id, status)}
              onSaveAnswers={(responses) => handleSaveAnswers(ref.id, responses)}
              onSummarise={() => handleSummarise(ref.id)}
              generatingQuestions={generatingQuestions === ref.id}
              summarising={summarising === ref.id}
              deleting={deletingRef === ref.id}
            />
          ))}

          {!addOpen ? (
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className="inline-flex items-center gap-1.5 text-xs text-accent hover:text-accent-hover font-medium"
            >
              <Plus className="w-3.5 h-3.5" />
              Add referee
            </button>
          ) : (
            <AddRefForm
              value={newRef}
              onChange={setNewRef}
              onSubmit={handleAddRef}
              onCancel={() => setAddOpen(false)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function RefCard({
  ref_,
  expanded,
  onToggle,
  onDelete,
  onGenerateQuestions,
  onStatusChange,
  onSaveAnswers,
  onSummarise,
  generatingQuestions,
  summarising,
  deleting,
}: {
  ref_: ReferenceCheck;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onGenerateQuestions: () => void;
  onStatusChange: (status: string) => void;
  onSaveAnswers: (responses: ReferenceResponse[]) => void;
  onSummarise: () => void;
  generatingQuestions: boolean;
  summarising: boolean;
  deleting: boolean;
}) {
  const questions = safeParseJson<ReferenceQuestion[]>(ref_.questions, []);
  const [answers, setAnswers] = useState<string[]>(() => {
    const rs = safeParseJson<ReferenceResponse[]>(ref_.responses, []);
    return questions.map((q) => rs.find((r) => r.question === q.question)?.answer ?? "");
  });

  // Sync answers when questions or responses change (e.g. after AI generation)
  useEffect(() => {
    const qs = safeParseJson<ReferenceQuestion[]>(ref_.questions, []);
    const rs = safeParseJson<ReferenceResponse[]>(ref_.responses, []);
    setAnswers(qs.map((q) => rs.find((r) => r.question === q.question)?.answer ?? ""));
  }, [ref_.questions, ref_.responses]);

  const handleSave = () => {
    const qs = safeParseJson<ReferenceQuestion[]>(ref_.questions, []);
    onSaveAnswers(qs.map((q, i) => ({ question: q.question, answer: answers[i] ?? "" })));
  };

  return (
    <div className="rounded border border-separator bg-surface-sunken overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2">
        <button type="button" onClick={onToggle} className="flex-1 flex items-center gap-2 text-left min-w-0">
          <ChevronRight
            className={cn(
              "w-3.5 h-3.5 text-text-tertiary flex-shrink-0 transition-transform",
              expanded && "rotate-90",
            )}
          />
          <div className="min-w-0">
            <p className="text-base font-medium text-text-primary truncate">{ref_.refereeName}</p>
            {(ref_.refereeTitle || ref_.refereeCompany) && (
              <p className="text-xs text-text-tertiary truncate">
                {[ref_.refereeTitle, ref_.refereeCompany].filter(Boolean).join(" · ")}
              </p>
            )}
          </div>
        </button>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <Badge className={STATUS_COLORS[ref_.status] ?? "bg-surface-hover text-text-secondary"}>
            {STATUS_LABELS[ref_.status] ?? ref_.status}
          </Badge>
          {ref_.status === "complete" && <CheckCircle2 className="w-3.5 h-3.5 text-success" />}
          <button
            type="button"
            onClick={onDelete}
            disabled={deleting}
            className="h-6 w-6 rounded flex items-center justify-center text-text-tertiary hover:text-danger hover:bg-surface-hover transition-colors ml-0.5"
          >
            {deleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="px-3 pb-3 space-y-2.5 border-t border-separator">
          {/* Referee details */}
          <div className="pt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-text-secondary">
            {ref_.relationship && (
              <p><span className="text-text-tertiary">Relationship:</span> {ref_.relationship}</p>
            )}
            {ref_.refereeEmail && (
              <p><span className="text-text-tertiary">Email:</span> {ref_.refereeEmail}</p>
            )}
            {ref_.refereePhone && (
              <p><span className="text-text-tertiary">Phone:</span> {ref_.refereePhone}</p>
            )}
          </div>

          {/* Status stepper */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {(["pending", "contacted", "received"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onStatusChange(s)}
                className={cn(
                  "text-xs px-2 py-0.5 rounded-sm border font-medium transition-colors",
                  ref_.status === s
                    ? cn(STATUS_COLORS[s], "border-separator-strong")
                    : "border-separator text-text-tertiary hover:border-separator-strong hover:text-text-secondary",
                )}
              >
                {STATUS_LABELS[s]}
              </button>
            ))}
          </div>

          {/* AI Summary */}
          {ref_.summary && (
            <div className="p-2.5 bg-success-subtle border border-success/30 rounded">
              <p className="text-2xs font-semibold text-success uppercase tracking-wider mb-1">AI Summary</p>
              <p className="text-base text-text-primary leading-relaxed">{ref_.summary}</p>
            </div>
          )}

          {/* Questions & answers or generate button */}
          {questions.length > 0 ? (
            <div className="space-y-2">
              <p className="text-2xs font-semibold text-text-tertiary uppercase tracking-wider">Questions</p>
              {questions.map((q, i) => (
                <div key={i}>
                  <p className="text-xs font-medium text-text-primary mb-1">
                    <span className="text-2xs text-text-tertiary mr-1 uppercase tracking-wider">{q.category}</span>
                    {q.question}
                  </p>
                  <textarea
                    value={answers[i] ?? ""}
                    onChange={(e) => setAnswers((a) => { const next = [...a]; next[i] = e.target.value; return next; })}
                    rows={2}
                    placeholder="Enter referee's answer…"
                    className="w-full text-base text-text-primary bg-surface-base border border-separator rounded px-2.5 py-1.5 placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus resize-none transition-all"
                  />
                </div>
              ))}
              <div className="flex items-center gap-2 pt-1">
                <Button size="sm" variant="ghost" onClick={handleSave}>
                  Save answers
                </Button>
                {ref_.responses && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={onSummarise}
                    loading={summarising}
                    disabled={summarising}
                    className="text-llama hover:text-llama hover:bg-llama-subtle"
                  >
                    {!summarising && <Sparkles className="w-3.5 h-3.5" />}
                    {summarising ? "Summarising…" : "AI summarise"}
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={onGenerateQuestions}
              loading={generatingQuestions}
              disabled={generatingQuestions}
              className="text-llama hover:text-llama hover:bg-llama-subtle"
            >
              {!generatingQuestions && <Sparkles className="w-3.5 h-3.5" />}
              {generatingQuestions ? "Generating questions…" : "Generate AI questions"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function AddRefForm({
  value,
  onChange,
  onSubmit,
  onCancel,
}: {
  value: { refereeName: string; refereeTitle: string; refereeCompany: string; refereeEmail: string; refereePhone: string; relationship: string };
  onChange: (v: typeof value) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const f = (label: string, key: keyof typeof value, placeholder?: string) => (
    <div>
      <label className="block text-2xs font-medium text-text-tertiary uppercase tracking-wider mb-1">{label}</label>
      <input
        type="text"
        value={value[key]}
        onChange={(e) => onChange({ ...value, [key]: e.target.value })}
        placeholder={placeholder ?? ""}
        className="w-full h-7 text-base text-text-primary bg-surface-base border border-separator rounded px-2.5 placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus transition-all"
      />
    </div>
  );

  return (
    <div className="rounded border border-accent/40 bg-accent-subtle p-3 space-y-2">
      <p className="text-md font-semibold text-text-primary">Add referee</p>
      <div className="grid grid-cols-2 gap-2">
        {f("Full name *", "refereeName", "Jane Smith")}
        {f("Relationship", "relationship", "Direct manager")}
        {f("Job title", "refereeTitle", "Head of Talent")}
        {f("Company", "refereeCompany", "Acme Co")}
        {f("Email", "refereeEmail", "jane@acme.com")}
        {f("Phone", "refereePhone", "+64 21 …")}
      </div>
      <div className="flex gap-2 pt-1">
        <Button
          size="sm"
          onClick={onSubmit}
          disabled={!value.refereeName.trim()}
        >
          <Plus className="w-3.5 h-3.5" />
          Add
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
