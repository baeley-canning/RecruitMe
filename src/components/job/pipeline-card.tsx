"use client";

import { cn, statusLabel } from "@/lib/utils";
import { Card, CardHeader, CardBody } from "@/components/ui/card";

interface PipelineCardProps {
  totalCount: number;
  statusCounts: Record<string, number>;
  filter: string;
  onFilterChange: (filter: string) => void;
}

export function PipelineCard({ totalCount, statusCounts, filter, onFilterChange }: PipelineCardProps) {
  const filterBtn = (value: string, label: string, count: number) => (
    <button
      key={value}
      onClick={() => onFilterChange(value)}
      className={cn(
        "w-full flex items-center justify-between px-3 py-1.5 rounded-lg text-sm transition-colors",
        filter === value ? "bg-blue-50 text-blue-700 font-medium" : "text-slate-600 hover:bg-slate-50"
      )}
    >
      <span>{label}</span>
      <span className={cn("font-semibold text-xs", count > 0 ? "" : "text-slate-300")}>{count}</span>
    </button>
  );

  return (
    <Card>
      <CardHeader>
        <h2 className="font-semibold text-slate-900 text-sm">Pipeline</h2>
      </CardHeader>
      <CardBody className="space-y-0.5">
        {filterBtn("all", "All candidates", totalCount)}

        <p className="text-xs text-slate-400 font-medium uppercase tracking-wide px-3 pt-2 pb-0.5">Pipeline</p>
        {(["new", "reviewing", "shortlisted", "contacted", "interviewing", "offer_sent"] as const).map((s) => {
          const count = statusCounts[s] ?? 0;
          if (count === 0 && !["new", "reviewing", "shortlisted"].includes(s)) return null;
          return filterBtn(s, statusLabel(s), count);
        })}

        <p className="text-xs text-slate-400 font-medium uppercase tracking-wide px-3 pt-2 pb-0.5">Closed</p>
        {(["hired", "declined", "rejected"] as const).map((s) =>
          filterBtn(s, statusLabel(s), statusCounts[s] ?? 0)
        )}
      </CardBody>
    </Card>
  );
}
