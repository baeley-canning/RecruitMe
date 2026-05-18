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
    <div className="mb-6 rounded-md border border-separator bg-surface-raised border-l-2 border-l-accent px-4 py-3 relative">
      <button
        onClick={handleDismiss}
        className="absolute top-3 right-3 text-text-tertiary hover:text-text-primary transition-colors"
        aria-label="Dismiss onboarding"
      >
        <X className="w-3.5 h-3.5" />
      </button>

      <div className="flex items-center gap-2 mb-3">
        <Sparkles className="w-3.5 h-3.5 text-accent" />
        <p className="text-md font-semibold text-text-primary">Get started — finding your first candidate</p>
      </div>

      <ol className="space-y-2.5">
        {steps.map((step, i) => (
          <li key={i} className="flex items-start gap-3">
            <div className="flex-shrink-0 mt-0.5">
              {step.done
                ? <CheckCircle2 className="w-3.5 h-3.5 text-success" />
                : <Circle className={cn("w-3.5 h-3.5", step.current ? "text-accent" : "text-text-tertiary")} />
              }
            </div>
            <div className="flex-1 min-w-0">
              <p className={cn(
                "text-md font-medium leading-tight",
                step.done ? "text-text-tertiary line-through" : step.current ? "text-text-primary" : "text-text-secondary"
              )}>
                {step.title}
              </p>
              {step.current && (
                <p className="text-base text-text-secondary mt-0.5 flex items-start gap-1">
                  <ArrowRight className="w-3 h-3 mt-0.5 flex-shrink-0 text-accent" />
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
