"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter, useParams } from "next/navigation";
import { ArrowLeft, Pencil, Check, X, Building2, DollarSign, Shield, Calendar } from "lucide-react";
import { showToast } from "@/components/ui/toast";
import { type Placement, feeLabel, guaranteeBadge, firstApiError } from "@/lib/placement-format";

/** Inline edit-in-place field (mirrors the clients detail page pattern). */
function InlineField({
  label, value, onSave, type = "text", multiline = false,
}: {
  label: string;
  value: string | null;
  onSave: (v: string | null) => Promise<void>;
  type?: string;
  multiline?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try { await onSave(draft.trim() || null); setEditing(false); }
    catch { /* toast handled in patch */ }
    finally { setSaving(false); }
  }
  function cancel() { setDraft(value ?? ""); setEditing(false); }

  return (
    <div className="group">
      <div className="text-xs font-medium text-text-tertiary mb-1">{label}</div>
      {editing ? (
        <div className="flex items-start gap-2">
          {multiline ? (
            <textarea autoFocus rows={4} value={draft} onChange={e => setDraft(e.target.value)}
              className="flex-1 border border-accent rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent bg-surface-sunken text-text-primary placeholder:text-text-tertiary resize-none" />
          ) : (
            <input autoFocus type={type} value={draft} onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") save(); if (e.key === "Escape") cancel(); }}
              className="flex-1 border border-accent rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent bg-surface-sunken text-text-primary placeholder:text-text-tertiary" />
          )}
          <button onClick={save} disabled={saving} className="mt-0.5 text-success hover:text-success disabled:opacity-50"><Check className="w-4 h-4" /></button>
          <button onClick={cancel} className="mt-0.5 text-text-tertiary hover:text-text-secondary"><X className="w-4 h-4" /></button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className={`text-sm ${value ? "text-text-primary" : "text-text-tertiary italic"}`}>{value || "—"}</span>
          <button onClick={() => { setDraft(value ?? ""); setEditing(true); }}
            className="opacity-0 group-hover:opacity-100 text-text-tertiary hover:text-text-secondary"><Pencil className="w-3.5 h-3.5" /></button>
        </div>
      )}
    </div>
  );
}

const NUMERIC_FIELDS = new Set(["salaryPlaced", "feePct", "feeAmount", "guaranteeMonths"]);
const INT_FIELDS = new Set(["salaryPlaced", "feeAmount", "guaranteeMonths"]); // int columns — round
const DATE_FIELDS = new Set(["startDate", "invoicedAt", "paidAt"]);
const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" }) : "—";

export default function PlacementDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [p, setP] = useState<Placement | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const res = await fetch(`/api/placements/${params.id}`);
    if (res.ok) setP(await res.json());
    else { showToast("Placement not found", "error"); router.push("/placements"); }
    setLoading(false);
  }, [params.id, router]);

  useEffect(() => { load(); }, [load]);

  const patch = useCallback(async (field: string, value: string | null) => {
    let payload: unknown = value;
    if (value === null) payload = null;
    else if (INT_FIELDS.has(field)) payload = Math.round(Number(value));
    else if (NUMERIC_FIELDS.has(field)) payload = Number(value);
    else if (DATE_FIELDS.has(field)) payload = new Date(value).toISOString();
    const res = await fetch(`/api/placements/${params.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: payload }),
    });
    if (res.ok) { setP(await res.json() as Placement); }
    else {
      const body = await res.json().catch(() => ({}));
      showToast(firstApiError(body.error, `Failed to save ${field}`), "error");
      throw new Error("save failed");
    }
  }, [params.id]);

  if (loading) return <div className="flex items-center justify-center h-64 text-text-tertiary text-sm">Loading…</div>;
  if (!p) return null;

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <button onClick={() => router.push("/placements")} className="flex items-center gap-1.5 text-sm text-text-tertiary hover:text-text-primary mb-6">
        <ArrowLeft className="w-4 h-4" /> Placements
      </button>

      <div className="grid grid-cols-3 gap-6">
        {/* Left: editable details */}
        <div className="col-span-2 space-y-6">
          <div className="border border-separator rounded-xl p-5 bg-surface-raised space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <InlineField label="Salary placed (NZD)" value={p.salaryPlaced != null ? String(p.salaryPlaced) : null} onSave={v => patch("salaryPlaced", v)} type="number" />
              <InlineField label="Start date" value={p.startDate ? p.startDate.slice(0, 10) : null} onSave={v => patch("startDate", v)} type="date" />
              <InlineField label={`Fee % ${p.feeType === "fixed" ? "(fixed mode)" : ""}`} value={p.feePct != null ? String(p.feePct) : null} onSave={v => patch("feePct", v)} type="number" />
              <InlineField label="Fee amount (NZD)" value={p.feeAmount != null ? String(p.feeAmount) : null} onSave={v => patch("feeAmount", v)} type="number" />
              <InlineField label="Guarantee (months)" value={p.guaranteeMonths != null ? String(p.guaranteeMonths) : null} onSave={v => patch("guaranteeMonths", v)} type="number" />
              <InlineField label="Invoice ref" value={p.invoiceRef} onSave={v => patch("invoiceRef", v)} />
            </div>
            <InlineField label="Notes" value={p.notes} onSave={v => patch("notes", v)} multiline />
          </div>

          {/* Read-only context */}
          <div className="border border-separator rounded-xl p-5 bg-surface-raised space-y-3">
            <h2 className="text-sm font-semibold text-text-secondary">Record</h2>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div><div className="text-xs text-text-tertiary">Placed</div><div className="text-text-primary">{fmtDate(p.placedAt)}</div></div>
              <div><div className="text-xs text-text-tertiary">Candidate ID</div><div className="text-text-secondary text-xs data-mono break-all">{p.candidateId}</div></div>
              {p.jobId && (
                <div><div className="text-xs text-text-tertiary">Job</div>
                  <button onClick={() => router.push(`/jobs/${p.jobId}`)} className="text-accent hover:underline text-sm">Open job</button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right: stats + actions */}
        <div className="space-y-3">
          <div className="border border-separator rounded-xl p-4 bg-surface-raised">
            <div className="text-xs text-text-tertiary mb-1 flex items-center gap-1"><DollarSign className="w-3.5 h-3.5" />Fee</div>
            <div className="text-2xl font-semibold text-text-primary">{feeLabel(p)}</div>
          </div>

          {p.client && (
            <button onClick={() => router.push(`/clients/${p.client!.id}`)} className="w-full flex items-center gap-2 border border-separator rounded-xl px-4 py-3 bg-surface-raised hover:border-accent text-left">
              <Building2 className="w-4 h-4 text-text-tertiary shrink-0" />
              <span className="text-sm text-text-primary truncate">{p.client.name}</span>
            </button>
          )}

          <div className="border border-separator rounded-xl p-4 bg-surface-raised space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-text-tertiary">Invoiced</span>
              {p.invoicedAt
                ? <span className="text-xs text-success flex items-center gap-0.5"><Check className="w-3 h-3" />{fmtDate(p.invoicedAt)}</span>
                : <button onClick={() => patch("invoicedAt", new Date().toISOString().slice(0, 10))} className="text-xs px-2 py-1 border border-separator rounded-lg text-text-secondary hover:border-accent hover:text-accent">Mark invoiced</button>}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-text-tertiary">Paid</span>
              {p.paidAt
                ? <span className="text-xs text-success flex items-center gap-0.5"><Check className="w-3 h-3" />{fmtDate(p.paidAt)}</span>
                : <button onClick={() => patch("paidAt", new Date().toISOString().slice(0, 10))} className="text-xs px-2 py-1 border border-success/40 text-success rounded-lg hover:bg-success-subtle">Mark paid</button>}
            </div>
          </div>

          {p.guaranteeExpiry && (
            <div className="border border-separator rounded-xl p-4 bg-surface-raised">
              <div className="text-xs text-text-tertiary mb-2 flex items-center gap-1"><Shield className="w-3.5 h-3.5" />Guarantee</div>
              <div className="flex items-center gap-2">
                {guaranteeBadge(p)}
                <span className="text-xs text-text-tertiary flex items-center gap-1"><Calendar className="w-3 h-3" />{fmtDate(p.guaranteeExpiry)}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
