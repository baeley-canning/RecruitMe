"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Circle, Sparkles, X, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface OnboardingCardProps {
  jobId: string;
  hasParsedRole: boolean;
  candidateCount: number;
  scoredCount: number;
}

interface Step {
  title: string;
  description: string;
  done: boolean;
  current: boolean;
}

function dismissKey(jobId: string) {
  return `recruitme:onboarding-dismissed:${jobId}`;
}

// Shown only on jobs the recruiter hasn't completed their first search on yet.
// Once dismissed (or once the third step is done), it stays hidden for that job.
export function OnboardingCard({ jobId, hasParsedRole, candidateCount, scoredCount }: OnboardingCardProps) {
  const [dismissed, setDismissed] = useState<boolean | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setDismissed(window.localStorage.getItem(dismissKey(jobId)) === "1");
  }, [jobId]);

  const steps: Step[] = [
    {
      title: "Job description analysed",
      description: "We turn your JD into structured requirements (must-haves, location rules, seniority).",
      done: hasParsedRole,
      current: !hasParsedRole,
    },
    {
      title: "Find candidates on LinkedIn",
      description: "Click “Search LinkedIn Now” below. We’ll surface and score the most likely matches.",
      done: candidateCount > 0,
      current: hasParsedRole && candidateCount === 0,
    },
    {
      title: "Review your top match",
      description: "Click any candidate to see why they scored well — strengths, gaps, and a recruiter summary.",
      done: scoredCount > 0,
      current: candidateCount > 0 && scoredCount === 0,
    },
  ];

  // Hide once all steps are done, or once the user dismisses.
  if (dismissed === null) return null;
  if (dismissed) return null;
  if (steps.every((s) => s.done)) {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(dismissKey(jobId), "1");
    }
    return null;
  }

  const handleDismiss = () => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(dismissKey(jobId), "1");
    }
    setDismissed(true);
  };

  return (
    <div className="mb-6 rounded-xl border border-blue-200 bg-gradient-to-br from-blue-50 to-white px-4 py-3 relative">
      <button
        onClick={handleDismiss}
        className="absolute top-3 right-3 text-slate-300 hover:text-slate-500"
        aria-label="Dismiss onboarding"
      >
        <X className="w-4 h-4" />
      </button>

      <div className="flex items-center gap-2 mb-3">
        <Sparkles className="w-4 h-4 text-blue-500" />
        <p className="text-sm font-semibold text-slate-800">Get started — finding your first candidate</p>
      </div>

      <ol className="space-y-2.5">
        {steps.map((step, i) => (
          <li key={i} className="flex items-start gap-3">
            <div className="flex-shrink-0 mt-0.5">
              {step.done
                ? <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                : <Circle className={cn("w-4 h-4", step.current ? "text-blue-500" : "text-slate-300")} />
              }
            </div>
            <div className="flex-1 min-w-0">
              <p className={cn(
                "text-sm font-medium leading-tight",
                step.done ? "text-slate-500 line-through" : step.current ? "text-slate-800" : "text-slate-500"
              )}>
                {step.title}
              </p>
              {step.current && (
                <p className="text-xs text-slate-500 mt-0.5 flex items-start gap-1">
                  <ArrowRight className="w-3 h-3 mt-0.5 flex-shrink-0 text-blue-400" />
                  {step.description}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
