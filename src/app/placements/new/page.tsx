"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { showToast } from "@/components/ui/toast";
import { firstApiError } from "@/lib/placement-format";

interface ClientOption {
  id: string;
  name: string;
}

function NewPlacementForm() {
  const router = useRouter();
  const sp = useSearchParams();

  const [candidateId, setCandidateId] = useState(sp.get("candidateId") ?? "");
  const [jobId] = useState(sp.get("jobId") ?? "");
  const [clientId, setClientId] = useState(sp.get("clientId") ?? "");
  const [salaryPlaced, setSalaryPlaced] = useState(sp.get("salary") ?? "");
  const [feeType, setFeeType] = useState<"percentage" | "fixed">("percentage");
  const [feePct, setFeePct] = useState("");
  const [feeAmount, setFeeAmount] = useState("");
  const [startDate, setStartDate] = useState("");
  const [guaranteeMonths, setGuaranteeMonths] = useState("");
  const [notes, setNotes] = useState("");
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/clients")
      .then(r => (r.ok ? r.json() : []))
      .then((data: ClientOption[]) => setClients(data))
      .catch(() => {});
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!candidateId.trim()) {
      showToast("A candidate ID is required", "error");
      return;
    }
    setSaving(true);
    try {
      // salaryPlaced / feeAmount / guaranteeMonths are int columns — round so a
      // decimal entry can't trigger a silent 422.
      const body: Record<string, unknown> = { candidateId: candidateId.trim() };
      if (jobId) body.jobId = jobId;
      if (clientId) body.clientId = clientId;
      if (salaryPlaced) body.salaryPlaced = Math.round(Number(salaryPlaced));
      body.feeType = feeType;
      if (feeType === "percentage" && feePct) body.feePct = Number(feePct);
      if (feeType === "fixed" && feeAmount) body.feeAmount = Math.round(Number(feeAmount));
      if (startDate) body.startDate = new Date(startDate).toISOString();
      if (guaranteeMonths) body.guaranteeMonths = Math.round(Number(guaranteeMonths));
      if (notes.trim()) body.notes = notes.trim();

      const res = await fetch("/api/placements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        showToast("Placement recorded", "success");
        router.push(`/placements/${data.id}`);
      } else {
        showToast(firstApiError(data.error, "Failed to record placement"), "error");
      }
    } finally {
      setSaving(false);
    }
  }

  const inputCls = "w-full border border-separator rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent bg-surface-sunken text-text-primary placeholder:text-text-tertiary";
  const labelCls = "block text-xs font-medium text-text-tertiary mb-1";

  return (
    <div className="max-w-xl mx-auto px-4 py-8">
      <button
        onClick={() => router.push("/placements")}
        className="flex items-center gap-1.5 text-sm text-text-tertiary hover:text-text-primary mb-6"
      >
        <ArrowLeft className="w-4 h-4" />
        Placements
      </button>

      <h1 className="text-2xl font-semibold text-text-primary mb-6">Record placement</h1>

      <form onSubmit={handleSubmit} className="space-y-4 border border-separator rounded-xl p-5 bg-surface-raised">
        <div>
          <label className={labelCls}>Candidate ID</label>
          <input
            value={candidateId}
            onChange={e => setCandidateId(e.target.value)}
            placeholder="Candidate ID"
            className={inputCls}
            readOnly={!!sp.get("candidateId")}
          />
          {!sp.get("candidateId") && (
            <p className="text-2xs text-text-tertiary mt-1">Tip: the natural path is &ldquo;Submit to client&rdquo; from a candidate; a manual ID is for ad-hoc records.</p>
          )}
        </div>

        <div>
          <label className={labelCls}>Client</label>
          <select value={clientId} onChange={e => setClientId(e.target.value)} className={inputCls}>
            <option value="">— no client —</option>
            {clients.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelCls}>Salary placed (NZD)</label>
            <input type="number" step="1" min="0" value={salaryPlaced} onChange={e => setSalaryPlaced(e.target.value)} placeholder="120000" className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Start date</label>
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className={inputCls} />
          </div>
        </div>

        <div>
          <label className={labelCls}>Fee</label>
          <div className="flex gap-2 mb-2">
            <button type="button" onClick={() => setFeeType("percentage")}
              className={`flex-1 px-3 py-1.5 text-sm rounded-lg border ${feeType === "percentage" ? "border-accent text-accent bg-accent-subtle" : "border-separator text-text-secondary"}`}>
              Percentage
            </button>
            <button type="button" onClick={() => setFeeType("fixed")}
              className={`flex-1 px-3 py-1.5 text-sm rounded-lg border ${feeType === "fixed" ? "border-accent text-accent bg-accent-subtle" : "border-separator text-text-secondary"}`}>
              Fixed
            </button>
          </div>
          {feeType === "percentage" ? (
            <input type="number" step="0.1" value={feePct} onChange={e => setFeePct(e.target.value)} placeholder="Fee % (e.g. 18)" className={inputCls} />
          ) : (
            <input type="number" step="1" min="0" value={feeAmount} onChange={e => setFeeAmount(e.target.value)} placeholder="Fee amount (NZD)" className={inputCls} />
          )}
        </div>

        <div>
          <label className={labelCls}>Guarantee (months)</label>
          <input type="number" value={guaranteeMonths} onChange={e => setGuaranteeMonths(e.target.value)} placeholder="3" className={inputCls} />
        </div>

        <div>
          <label className={labelCls}>Notes</label>
          <textarea rows={3} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Any context about this placement…" className={`${inputCls} resize-none`} />
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={() => router.push("/placements")} className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary">
            Cancel
          </button>
          <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-accent text-text-inverse rounded-lg hover:bg-accent-hover disabled:opacity-50">
            {saving ? "Saving…" : "Record placement"}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function NewPlacementPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-64 text-text-tertiary text-sm">Loading…</div>}>
      <NewPlacementForm />
    </Suspense>
  );
}
