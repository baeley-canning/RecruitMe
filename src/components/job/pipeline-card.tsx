"use client";

import { Check } from "lucide-react";
import { cn, statusLabel } from "@/lib/utils";
import { Card, CardHeader, CardBody } from "@/components/ui/card";

interface PipelineCardProps {
  totalCount: number;
  statusCounts: Record<string, number>;
  // Empty array = no filter (show all). Multiple entries = OR-filter across
  // statuses, e.g. ["shortlisted", "contacted"] = active pipeline view.
  filter: string[];
  onFilterChange: (filter: string[]) => void;
}

export function PipelineCard({ totalCount, statusCounts, filter, onFilterChange }: PipelineCardProps) {
  const isFiltered = filter.length > 0;

  const toggle = (status: string) => {
    if (filter.includes(status)) {
      onFilterChange(filter.filter((s) => s !== status));
    } else {
      onFilterChange([...filter, status]);
    }
  };

  const filterBtn = (value: string, label: string, count: number) => {
    const active = filter.includes(value);
    return (
      <button
        key={value}
        onClick={() => toggle(value)}
        className={cn(
          "w-full flex items-center justify-between px-3 py-1.5 rounded-lg text-sm transition-colors",
          active ? "bg-blue-50 text-blue-700 font-medium" : "text-slate-600 hover:bg-slate-50"
        )}
        aria-pressed={active}
      >
        <span className="flex items-center gap-2">
          {active && <Check className="w-3.5 h-3.5 flex-shrink-0" />}
          {label}
        </span>
        <span className={cn("font-semibold text-xs", count > 0 ? "" : "text-slate-300")}>{count}</span>
      </button>
    );
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-slate-900 text-sm">Pipeline</h2>
          {isFiltered && (
            <button
              onClick={() => onFilterChange([])}
              className="text-[11px] text-slate-400 hover:text-slate-600 underline"
            >
              Clear filter
            </button>
          )}
        </div>
      </CardHeader>
      <CardBody className="space-y-0.5">
        <button
          onClick={() => onFilterChange([])}
          className={cn(
            "w-full flex items-center justify-between px-3 py-1.5 rounded-lg text-sm transition-colors",
            !isFiltered ? "bg-blue-50 text-blue-700 font-medium" : "text-slate-600 hover:bg-slate-50"
          )}
        >
          <span>All candidates</span>
          <span className="font-semibold text-xs">{totalCount}</span>
        </button>

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

        {isFiltered && (
          <p className="text-[11px] text-slate-400 px-3 pt-2 pb-0.5 italic">
            Tip: click multiple statuses to combine them.
          </p>
        )}
      </CardBody>
    </Card>
  );
}
