/**
 * Shared placement types + display helpers, used by the placements list page
 * and the placement detail page. Lifted out of placements/page.tsx so both
 * pages render fees/guarantees identically (no duplication).
 */

export interface Placement {
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

/**
 * Surface a human message from an API error body. Routes return either a
 * string `error` or a zod `flatten()` object ({ formErrors, fieldErrors }) on
 * 422 — pull the first useful message instead of a generic fallback.
 */
export function firstApiError(err: unknown, fallback: string): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const f = err as { formErrors?: string[]; fieldErrors?: Record<string, string[]> };
    if (f.formErrors?.length) return f.formErrors[0];
    if (f.fieldErrors) {
      for (const k of Object.keys(f.fieldErrors)) {
        const msgs = f.fieldErrors[k];
        if (msgs?.length) return `${k}: ${msgs[0]}`;
      }
    }
  }
  return fallback;
}

export function fmtMoney(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(0)}k`;
  return `$${n}`;
}

/** Computed agency fee for a placement, as a display string. */
export function feeLabel(p: Pick<Placement, "feeAmount" | "feePct" | "salaryPlaced">): string {
  if (p.feeAmount) return fmtMoney(p.feeAmount);
  if (p.feePct && p.salaryPlaced) return `${fmtMoney(Math.round(p.salaryPlaced * p.feePct / 100))} (${p.feePct}%)`;
  if (p.feePct) return `${p.feePct}%`;
  return "—";
}

/** Numeric fee value (for totals). */
export function feeValue(p: Pick<Placement, "feeAmount" | "feePct" | "salaryPlaced">): number {
  if (p.feeAmount) return p.feeAmount;
  if (p.feePct && p.salaryPlaced) return Math.round(p.salaryPlaced * p.feePct / 100);
  return 0;
}

export function guaranteeBadge(p: Pick<Placement, "guaranteeExpiry">): React.ReactNode {
  if (!p.guaranteeExpiry) return null;
  const daysLeft = Math.round((new Date(p.guaranteeExpiry).getTime() - Date.now()) / (86400 * 1000));
  if (daysLeft < 0) return <span className="text-xs px-2 py-0.5 rounded-full bg-surface-hover text-text-tertiary">Expired</span>;
  if (daysLeft <= 14) return <span className="text-xs px-2 py-0.5 rounded-full bg-danger-subtle text-danger">{daysLeft}d left</span>;
  if (daysLeft <= 30) return <span className="text-xs px-2 py-0.5 rounded-full bg-warning-subtle text-warning">{daysLeft}d left</span>;
  return <span className="text-xs px-2 py-0.5 rounded-full bg-success-subtle text-success">{daysLeft}d</span>;
}
