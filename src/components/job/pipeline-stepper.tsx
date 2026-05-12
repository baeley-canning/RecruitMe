"use client";

import { useCallback, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * PipelineStepper — horizontal 5-stage flow visualisation for a job's candidate
 * pipeline. Recruiters click a stage to filter the candidate list. The
 * component is purely presentational; counts come in via props, and stage
 * selection is owned by the parent.
 *
 * Stage IDs match the conceptual flow (NOT 1:1 with Candidate.status — see
 * pipeline-card.tsx for the raw enum). The parent is responsible for mapping
 * Candidate.status rows into these buckets:
 *
 *   fetched     — "new" / any pre-shortlist status (imported, not yet sorted)
 *   scored      — has matchScore > 0 but still in "new" or "reviewing"
 *   shortlisted — status === "shortlisted"
 *   contacted   — status in ("contacted", "interviewing", "offer_sent")
 *   hired       — status === "hired"
 *
 *   (declined / rejected are TERMINAL and not a stage — surfaced as a small
 *   hint on the right edge via `rejectedCount`.)
 */
export type PipelineStage =
  | "fetched"
  | "scored"
  | "shortlisted"
  | "contacted"
  | "hired";

export interface PipelineStepperProps {
  counts: Record<PipelineStage, number>;
  rejectedCount?: number;
  selectedStage: PipelineStage | "all";
  onStageChange: (stage: PipelineStage | "all") => void;
}

const STAGES: ReadonlyArray<{ id: PipelineStage; label: string }> = [
  { id: "fetched", label: "Fetched" },
  { id: "scored", label: "Scored" },
  { id: "shortlisted", label: "Shortlist" },
  { id: "contacted", label: "Contacted" },
  { id: "hired", label: "Hired" },
];

export function PipelineStepper({
  counts,
  rejectedCount = 0,
  selectedStage,
  onStageChange,
}: PipelineStepperProps) {
  // Refs for keyboard nav — arrow keys jump focus between stage buttons.
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const total = useMemo(
    () =>
      STAGES.reduce((sum, s) => sum + (counts[s.id] ?? 0), 0),
    [counts]
  );

  // A stage is "filled" (passed through) when it has candidates AND any
  // later stage also has candidates — i.e. work has flowed past it. The
  // currently-selected stage is always treated as filled for visual emphasis.
  const isStageFilled = useCallback(
    (index: number): boolean => {
      const stage = STAGES[index];
      if (selectedStage === stage.id) return true;
      const ownCount = counts[stage.id] ?? 0;
      if (ownCount === 0) return false;
      for (let i = index + 1; i < STAGES.length; i++) {
        if ((counts[STAGES[i].id] ?? 0) > 0) return true;
      }
      return false;
    },
    [counts, selectedStage]
  );

  const handleKeyDown = (
    e: React.KeyboardEvent<HTMLButtonElement>,
    index: number
  ) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const dir = e.key === "ArrowRight" ? 1 : -1;
    const nextIndex = (index + dir + STAGES.length) % STAGES.length;
    const nextStage = STAGES[nextIndex];
    buttonRefs.current[nextIndex]?.focus();
    onStageChange(nextStage.id);
  };

  return (
    <section
      className="rounded-md bg-surface-raised border border-separator p-4"
      aria-label="Candidate pipeline"
    >
      <div className="flex items-center gap-3">
        {/* "All" reset — ghost button on the left with monospace total. */}
        <button
          type="button"
          onClick={() => onStageChange("all")}
          aria-pressed={selectedStage === "all"}
          aria-label={`Show all candidates: ${total} total`}
          className={cn(
            "h-7 px-2.5 rounded text-xs font-medium border transition-colors flex items-center gap-1.5 flex-shrink-0",
            selectedStage === "all"
              ? "bg-surface-hover border-separator-strong text-text-primary"
              : "bg-transparent border-separator text-text-secondary hover:text-text-primary hover:bg-surface-hover"
          )}
        >
          <span>All</span>
          <span className="data-mono tabular-nums text-text-primary">
            {total}
          </span>
        </button>

        {/* Stepper rail — flex grow so it spans the rest of the row. */}
        <div className="flex-1 min-w-0">
          <div
            className="grid"
            style={{
              gridTemplateColumns: `repeat(${STAGES.length}, minmax(0, 1fr))`,
            }}
            role="group"
          >
            {STAGES.map((stage, index) => {
              const count = counts[stage.id] ?? 0;
              const filled = isStageFilled(index);
              const selected = selectedStage === stage.id;
              const nextFilled =
                index < STAGES.length - 1 ? isStageFilled(index + 1) : false;
              const connectorFilled = filled && nextFilled;
              const isLast = index === STAGES.length - 1;

              return (
                <div
                  key={stage.id}
                  className="relative flex flex-col items-center"
                >
                  {/* Connector line — sits behind the dot row, anchored
                      from the centre of this dot to the centre of the next.
                      Hidden on the last stage. */}
                  {!isLast && (
                    <span
                      aria-hidden="true"
                      className={cn(
                        "absolute top-[26px] left-1/2 right-[-50%] h-0.5 -z-0",
                        connectorFilled
                          ? "bg-accent"
                          : "bg-separator-strong"
                      )}
                    />
                  )}

                  <button
                    type="button"
                    ref={(el) => {
                      buttonRefs.current[index] = el;
                    }}
                    onClick={() => onStageChange(stage.id)}
                    onKeyDown={(e) => handleKeyDown(e, index)}
                    aria-pressed={selected}
                    aria-label={`Filter to ${stage.label}: ${count} candidates`}
                    className={cn(
                      "group relative z-10 flex flex-col items-center gap-1 px-1 py-0.5 rounded transition-colors",
                      "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-subtle"
                    )}
                  >
                    {/* Label above */}
                    <span
                      className={cn(
                        "text-xs transition-colors",
                        selected
                          ? "text-text-primary font-medium"
                          : "text-text-secondary group-hover:text-text-primary"
                      )}
                    >
                      {stage.label}
                    </span>

                    {/* Dot — 12px circle. Filled, hollow, or selected ring. */}
                    <span
                      aria-hidden="true"
                      className={cn(
                        "w-3 h-3 rounded-full transition-colors",
                        selected
                          ? "bg-accent ring-2 ring-accent-subtle ring-offset-0"
                          : filled
                            ? "bg-accent"
                            : "border-2 border-separator-strong bg-surface-base"
                      )}
                    />

                    {/* Count below */}
                    <span
                      className={cn(
                        "data-mono tabular-nums text-md transition-colors",
                        count > 0
                          ? "text-text-primary"
                          : "text-text-tertiary"
                      )}
                    >
                      {count}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Rejected hint — terminal bucket, not a stage. Subtle. */}
        {rejectedCount > 0 && (
          <span
            className="text-xs text-text-tertiary flex-shrink-0"
            aria-label={`${rejectedCount} rejected (not shown in pipeline)`}
          >
            <span className="data-mono tabular-nums">× {rejectedCount}</span>{" "}
            rejected
          </span>
        )}
      </div>
    </section>
  );
}
