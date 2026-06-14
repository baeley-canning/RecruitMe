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
