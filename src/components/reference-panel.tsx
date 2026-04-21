"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  ChevronDown, ChevronUp, UserCheck, Plus, Sparkles,
  Loader2, X, CheckCircle2, ChevronRight,
} from "lucide-react";
import { Button } from "./ui/button";
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

const STATUS_COLORS: Record<string, string> = {
  pending:   "bg-slate-100 text-slate-500",
  contacted: "bg-blue-50 text-blue-600",
  received:  "bg-amber-50 text-amber-700",
  complete:  "bg-emerald-50 text-emerald-700",
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
    <div className="border border-slate-200 rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2.5 bg-slate-50 hover:bg-slate-100 transition-colors"
      >
        <div className="flex items-center gap-2">
          <UserCheck className="w-3.5 h-3.5 text-slate-400" />
          <span className="text-xs font-medium text-slate-700">Reference Checks</span>
          {refs.length > 0 && (
            <span className="text-[10px] bg-slate-200 text-slate-600 rounded-full px-1.5 py-0.5">
              {completeCount}/{refs.length}
            </span>
          )}
        </div>
        {open ? <ChevronUp className="w-3.5 h-3.5 text-slate-400" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-400" />}
      </button>

      {open && (
        <div className="p-3 space-y-3">
          {loading && (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
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
              className="flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-700 font-medium"
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
    <div className="border border-slate-200 rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-white">
        <button type="button" onClick={onToggle} className="flex-1 flex items-center gap-2 text-left min-w-0">
          <ChevronRight className={cn("w-3.5 h-3.5 text-slate-400 flex-shrink-0 transition-transform", expanded && "rotate-90")} />
          <div className="min-w-0">
            <p className="text-xs font-semibold text-slate-800 truncate">{ref_.refereeName}</p>
            {(ref_.refereeTitle || ref_.refereeCompany) && (
              <p className="text-[10px] text-slate-500 truncate">
                {[ref_.refereeTitle, ref_.refereeCompany].filter(Boolean).join(" · ")}
              </p>
            )}
          </div>
        </button>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full font-medium", STATUS_COLORS[ref_.status] ?? "bg-slate-100 text-slate-500")}>
            {STATUS_LABELS[ref_.status] ?? ref_.status}
          </span>
          {ref_.status === "complete" && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />}
          <button
            type="button"
            onClick={onDelete}
            disabled={deleting}
            className="text-slate-300 hover:text-red-500 transition-colors ml-1"
          >
            {deleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="px-3 pb-3 space-y-3 border-t border-slate-100">
          {/* Referee details */}
          <div className="pt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-slate-600">
            {ref_.relationship && <p><span className="text-slate-400">Relationship:</span> {ref_.relationship}</p>}
            {ref_.refereeEmail && <p><span className="text-slate-400">Email:</span> {ref_.refereeEmail}</p>}
            {ref_.refereePhone && <p><span className="text-slate-400">Phone:</span> {ref_.refereePhone}</p>}
          </div>

          {/* Status stepper */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {(["pending", "contacted", "received"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onStatusChange(s)}
                className={cn(
                  "text-[10px] px-2 py-0.5 rounded-full border font-medium transition-colors",
                  ref_.status === s
                    ? cn(STATUS_COLORS[s], "border-current")
                    : "border-slate-200 text-slate-400 hover:border-slate-300 hover:text-slate-600"
                )}
              >
                {STATUS_LABELS[s]}
              </button>
            ))}
          </div>

          {/* AI Summary */}
          {ref_.summary && (
            <div className="p-2.5 bg-emerald-50 border border-emerald-100 rounded-lg">
              <p className="text-[10px] font-semibold text-emerald-700 uppercase tracking-wide mb-1">AI Summary</p>
              <p className="text-xs text-slate-700 leading-relaxed">{ref_.summary}</p>
            </div>
          )}

          {/* Questions & answers or generate button */}
          {questions.length > 0 ? (
            <div className="space-y-2">
              <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Questions</p>
              {questions.map((q, i) => (
                <div key={i}>
                  <p className="text-xs font-medium text-slate-700 mb-1">
                    <span className="text-[10px] text-slate-400 mr-1 uppercase">{q.category}</span>
                    {q.question}
                  </p>
                  <textarea
                    value={answers[i] ?? ""}
                    onChange={(e) => setAnswers((a) => { const next = [...a]; next[i] = e.target.value; return next; })}
                    rows={2}
                    placeholder="Enter referee's answer…"
                    className="w-full text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 resize-none focus:outline-none focus:ring-2 focus:ring-blue-400"
                  />
                </div>
              ))}
              <div className="flex items-center gap-2 pt-1">
                <Button size="sm" variant="ghost" onClick={handleSave} className="text-blue-600 hover:bg-blue-50">
                  Save answers
                </Button>
                {ref_.responses && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={onSummarise}
                    loading={summarising}
                    disabled={summarising}
                    className="text-violet-600 hover:bg-violet-50"
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
              className="text-violet-600 hover:bg-violet-50"
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
      <label className="block text-[10px] font-medium text-slate-500 mb-1">{label}</label>
      <input
        type="text"
        value={value[key]}
        onChange={(e) => onChange({ ...value, [key]: e.target.value })}
        placeholder={placeholder ?? ""}
        className="w-full text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-400"
      />
    </div>
  );

  return (
    <div className="border border-blue-200 bg-blue-50/40 rounded-lg p-3 space-y-2">
      <p className="text-xs font-semibold text-slate-700">Add referee</p>
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
          className="text-xs"
        >
          <Plus className="w-3.5 h-3.5" />
          Add
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} className="text-slate-500">
          Cancel
        </Button>
      </div>
    </div>
  );
}
