"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Plus, DollarSign, Calendar, Shield, Check, ChevronRight } from "lucide-react";
import { showToast } from "@/components/ui/toast";
import { type Placement, fmtMoney, feeLabel, feeValue, guaranteeBadge } from "@/lib/placement-format";

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

  const totalFee = placements.reduce((s, p) => s + feeValue(p), 0);
  const paidFee = placements.filter(p => p.paidAt).reduce((s, p) => s + feeValue(p), 0);

  const expiringCount = placements.filter(p => {
    if (!p.guaranteeExpiry) return false;
    const days = Math.round((new Date(p.guaranteeExpiry).getTime() - Date.now()) / 86400000);
    return days >= 0 && days <= 30;
  }).length;

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">Placements</h1>
          <p className="text-sm text-text-tertiary mt-1">{placements.length} placement{placements.length !== 1 ? "s" : ""}</p>
        </div>
        <button
          onClick={() => router.push("/placements/new")}
          className="flex items-center gap-2 px-4 py-2 bg-accent text-white text-sm rounded-lg hover:bg-accent-hover"
        >
          <Plus className="w-4 h-4" />
          Record placement
        </button>
      </div>

      {/* Stats strip */}
      {placements.length > 0 && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="border border-separator rounded-xl p-4 bg-surface-raised">
            <div className="text-xs text-text-tertiary mb-1 flex items-center gap-1"><DollarSign className="w-3.5 h-3.5" />Total fees</div>
            <div className="text-xl font-semibold text-text-primary">{totalFee > 0 ? fmtMoney(totalFee) : "—"}</div>
          </div>
          <div className="border border-separator rounded-xl p-4 bg-surface-raised">
            <div className="text-xs text-text-tertiary mb-1 flex items-center gap-1"><Check className="w-3.5 h-3.5" />Paid</div>
            <div className="text-xl font-semibold text-success">{paidFee > 0 ? fmtMoney(paidFee) : "—"}</div>
          </div>
          <div className="border border-separator rounded-xl p-4 bg-surface-raised">
            <div className="text-xs text-text-tertiary mb-1 flex items-center gap-1"><Shield className="w-3.5 h-3.5" />Guarantees expiring soon</div>
            <div className={`text-xl font-semibold ${expiringCount > 0 ? "text-warning" : "text-text-primary"}`}>{expiringCount}</div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-16 text-text-tertiary text-sm">Loading…</div>
      ) : placements.length === 0 ? (
        <div className="text-center py-16 text-text-tertiary">
          <DollarSign className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No placements yet — record your first one.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {placements.map(p => (
            <div key={p.id} className="flex items-center gap-4 border border-separator rounded-xl px-4 py-3 bg-surface-raised">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text-primary truncate">{p.client?.name ?? "No client"}</span>
                  {guaranteeBadge(p)}
                  {p.paidAt && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-success-subtle text-success flex items-center gap-0.5">
                      <Check className="w-3 h-3" /> Paid
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 mt-0.5 text-xs text-text-tertiary">
                  <span className="flex items-center gap-1">
                    <Calendar className="w-3 h-3" />
                    {new Date(p.placedAt).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" })}
                  </span>
                  {feeLabel(p) !== "—" && (
                    <span className="flex items-center gap-0.5 font-medium text-text-secondary">
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
                    className="text-xs px-3 py-1.5 border border-success/40 text-success rounded-lg hover:bg-success-subtle"
                  >
                    Mark paid
                  </button>
                )}
                <button onClick={() => router.push(`/placements/${p.id}`)} className="text-text-tertiary hover:text-text-secondary">
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
