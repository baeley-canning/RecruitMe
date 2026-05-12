"use client";

import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Tiny inline status messages used across cards and forms.
 *
 * Adopt these whenever you'd otherwise hand-roll an icon + colour pair like
 *   <p className="text-xs text-amber-700 ...">⚠ failed to load</p>
 * They keep tone/colour/icon roles aligned across the app so a recruiter sees
 * "warning amber" for warnings everywhere instead of three different ambers.
 */

type PillProps = {
  children: React.ReactNode;
  className?: string;
};

const baseClass =
  "inline-flex items-center gap-1 h-5 px-1.5 py-0.5 rounded-sm text-xs font-medium leading-none";

export function ErrorPill({ children, className }: PillProps) {
  return (
    <span className={cn(baseClass, "bg-danger-subtle text-danger", className)}>
      <AlertCircle className="w-3 h-3 flex-shrink-0" />
      {children}
    </span>
  );
}

export function WarningPill({ children, className }: PillProps) {
  return (
    <span className={cn(baseClass, "bg-warning-subtle text-warning", className)}>
      <AlertCircle className="w-3 h-3 flex-shrink-0" />
      {children}
    </span>
  );
}

export function SuccessPill({ children, className }: PillProps) {
  return (
    <span className={cn(baseClass, "bg-success-subtle text-success", className)}>
      <CheckCircle2 className="w-3 h-3 flex-shrink-0" />
      {children}
    </span>
  );
}

export function LoadingPill({ children, className }: PillProps) {
  return (
    <span className={cn(baseClass, "bg-surface-hover text-text-secondary", className)}>
      <Loader2 className="w-3 h-3 flex-shrink-0 animate-spin" />
      {children}
    </span>
  );
}

/**
 * Card-level error banner: when a fetch fails and the card has nothing else
 * to show, render this instead of returning null. Pairs with the audit-flagged
 * pattern of "card silently renders nothing on load failure".
 */
export function CardLoadError({ message, className }: { message: string; className?: string }) {
  return (
    <div className={cn(
      "mb-6 rounded-md border border-separator bg-warning-subtle px-3 py-2 flex items-center gap-2",
      className,
    )}>
      <AlertCircle className="w-3.5 h-3.5 text-warning flex-shrink-0" />
      <p className="text-xs text-warning">{message}</p>
    </div>
  );
}
