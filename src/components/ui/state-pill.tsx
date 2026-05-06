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

const baseClass = "inline-flex items-center gap-1.5 text-xs leading-snug";

export function ErrorPill({ children, className }: PillProps) {
  return (
    <span className={cn(baseClass, "text-red-600", className)}>
      <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
      {children}
    </span>
  );
}

export function WarningPill({ children, className }: PillProps) {
  return (
    <span className={cn(baseClass, "text-amber-700", className)}>
      <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
      {children}
    </span>
  );
}

export function SuccessPill({ children, className }: PillProps) {
  return (
    <span className={cn(baseClass, "text-emerald-600", className)}>
      <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" />
      {children}
    </span>
  );
}

export function LoadingPill({ children, className }: PillProps) {
  return (
    <span className={cn(baseClass, "text-slate-500", className)}>
      <Loader2 className="w-3.5 h-3.5 flex-shrink-0 animate-spin" />
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
      "mb-6 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 flex items-center gap-2",
      className,
    )}>
      <AlertCircle className="w-3.5 h-3.5 text-amber-600 flex-shrink-0" />
      <p className="text-xs text-amber-700">{message}</p>
    </div>
  );
}
