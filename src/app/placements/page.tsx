"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Plus, DollarSign, Calendar, Shield, Check, X, ChevronRight } from "lucide-react";
import { showToast } from "@/components/ui/toast";

interface Placement {
  id: string;
  orgId: string;
  candidateId: string;
  jobId: string | null;
  clientId: string | null;
  client: { id: string; name: string } | null;
  submissionId: string | null;
  placedAt: string;
  startDate: string | null;
  salaryPlaced: number | null;
  feeType: string;
  feePct: number | null;
  feeAmount: number | null;
  invoiceRef: string | null;
  invoicedAt: string | null;
  paidAt: string | null;
  guaranteeMonths: number | null;
  guaranteeExpiry: string | null;
  notes: string | null;
}

function fmtMoney(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(0)}k`;
  return `$${n}`;
}

function feeLabel(p: Placement): string {
  if (p.feeAmount) return fmtMoney(p.feeAmount);
  if (p.feePct && p.salaryPlaced) return `${fmtMoney(Math.round(p.salaryPlaced * p.feePct / 100))} (${p.feePct}%)`;
  if (p.feePct) return `${p.feePct}%`;
  return "—";
}

function guaranteeBadge(p: Placement): React.ReactNode {
  if (!p.guaranteeExpiry) return null;
  const daysLeft = Math.round((new Date(p.guaranteeExpiry).getTime() - Date.now()) / (86400 * 1000));
  if (daysLeft < 0) return <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">Expired</span>;
  if (daysLeft <= 14) return <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700">{daysLeft}d left</span>;
  if (daysLeft <= 30) return <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">{daysLeft}d left</span>;
  return <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">{daysLeft}d</span>;
}

export default function PlacementsPage() {
  const router = useRouter();
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const res = await fetch("/api/placements");
    if (res.ok) setPlacements(await res.json());
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function markPaid(id: string) {
    const res = await fetch(`/api/placements/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paidAt: new Date().toISOString() }),
    });
    if (res.ok) {
      showToast("Marked as paid", "success");
      setPlacements(ps => ps.map(p => p.id === id ? { ...p, paidAt: new Date().toISOString() } : p));
    } else {
      showToast("Failed to update", "error");
    }
  }

  const totalFee = placements.reduce((s, p) => {
    if (p.feeAmount) return s + p.feeAmount;
    if (p.feePct && p.salaryPlaced) return s + Math.round(p.salaryPlaced * p.feePct / 100);
    return s;
  }, 0);

  const paidFee = placements.filter(p => p.paidAt).reduce((s, p) => {
    if (p.feeAmount) return s + p.feeAmount;
    if (p.feePct && p.salaryPlaced) return s + Math.round(p.salaryPlaced * p.feePct / 100);
    return s;
  }, 0);

  const expiringCount = placements.filter(p => {
    if (!p.guaranteeExpiry) return false;
    const days = Math.round((new Date(p.guaranteeExpiry).getTime() - Date.now()) / 86400000);
    return days >= 0 && days <= 30;
  }).length;

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Placements</h1>
          <p className="text-sm text-gray-500 mt-1">{placements.length} placement{placements.length !== 1 ? "s" : ""}</p>
        </div>
        <button
          onClick={() => router.push("/placements/new")}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700"
        >
          <Plus className="w-4 h-4" />
          Record placement
        </button>
      </div>

      {/* Stats strip */}
      {placements.length > 0 && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="border border-gray-200 rounded-xl p-4 bg-white">
            <div className="text-xs text-gray-500 mb-1 flex items-center gap-1"><DollarSign className="w-3.5 h-3.5" />Total fees</div>
            <div className="text-xl font-semibold text-gray-900">{totalFee > 0 ? fmtMoney(totalFee) : "—"}</div>
          </div>
          <div className="border border-gray-200 rounded-xl p-4 bg-white">
            <div className="text-xs text-gray-500 mb-1 flex items-center gap-1"><Check className="w-3.5 h-3.5" />Paid</div>
            <div className="text-xl font-semibold text-green-700">{paidFee > 0 ? fmtMoney(paidFee) : "—"}</div>
          </div>
          <div className="border border-gray-200 rounded-xl p-4 bg-white">
            <div className="text-xs text-gray-500 mb-1 flex items-center gap-1"><Shield className="w-3.5 h-3.5" />Guarantees expiring soon</div>
            <div className={`text-xl font-semibold ${expiringCount > 0 ? "text-amber-700" : "text-gray-900"}`}>{expiringCount}</div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-16 text-gray-400 text-sm">Loading…</div>
      ) : placements.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <DollarSign className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No placements yet — record your first one.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {placements.map(p => (
            <div key={p.id} className="flex items-center gap-4 border border-gray-200 rounded-xl px-4 py-3 bg-white">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-900 truncate">{p.client?.name ?? "No client"}</span>
                  {guaranteeBadge(p)}
                  {p.paidAt && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 flex items-center gap-0.5">
                      <Check className="w-3 h-3" /> Paid
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 mt-0.5 text-xs text-gray-500">
                  <span className="flex items-center gap-1">
                    <Calendar className="w-3 h-3" />
                    {new Date(p.placedAt).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" })}
                  </span>
                  {feeLabel(p) !== "—" && (
                    <span className="flex items-center gap-0.5 font-medium text-gray-700">
                      <DollarSign className="w-3 h-3" />{feeLabel(p)}
                    </span>
                  )}
                  {p.guaranteeMonths && (
                    <span className="flex items-center gap-0.5">
                      <Shield className="w-3 h-3" />{p.guaranteeMonths}mo guarantee
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {!p.paidAt && (feeLabel(p) !== "—") && (
                  <button
                    onClick={() => markPaid(p.id)}
                    className="text-xs px-3 py-1.5 border border-green-300 text-green-700 rounded-lg hover:bg-green-50"
                  >
                    Mark paid
                  </button>
                )}
                <button onClick={() => router.push(`/placements/${p.id}`)} className="text-gray-400 hover:text-gray-700">
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
