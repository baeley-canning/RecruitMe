"use client";

import { useEffect, useState, useCallback } from "react";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";

type ToastVariant = "success" | "error" | "info";
export type ToastPayload = { id: number; message: string; variant: ToastVariant };

let toastListeners: Array<(t: ToastPayload) => void> = [];
let toastIdSeq = 0;

// Imperative API: anywhere in client code, `showToast("Saved")` to surface a
// notification. Subscribers (the <Toaster/> mounted at the page root) handle
// rendering and auto-dismiss.
export function showToast(message: string, variant: ToastVariant = "success") {
  const t: ToastPayload = { id: ++toastIdSeq, message, variant };
  toastListeners.forEach((fn) => fn(t));
}

export function Toaster() {
  const [toasts, setToasts] = useState<ToastPayload[]>([]);

  useEffect(() => {
    const listener = (t: ToastPayload) => {
      setToasts((prev) => [...prev, t]);
      // Auto-dismiss after 4s. Errors live longer (6s) so they're not missed.
      const ttl = t.variant === "error" ? 6000 : 4000;
      setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== t.id)), ttl);
    };
    toastListeners.push(listener);
    return () => { toastListeners = toastListeners.filter((l) => l !== listener); };
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);

  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[1200] flex flex-col gap-2 items-center">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          // Shared surface: floating overlay tone, hairline border, popover
          // shadow. The variant only swaps the left accent stripe + icon
          // colour — the body chrome stays consistent across success/error/
          // info, which is the Logic Pro restraint we want.
          className={cn(
            "min-w-[260px] max-w-sm flex items-center gap-2 p-3 rounded-md text-md font-medium",
            "bg-surface-overlay text-text-primary border border-separator shadow-popover",
            "border-l-2",
            t.variant === "success" && "border-l-success",
            t.variant === "error"   && "border-l-danger",
            t.variant === "info"    && "border-l-accent",
          )}
        >
          {t.variant === "success" && <CheckCircle2 className="w-4 h-4 flex-shrink-0 text-success" />}
          {t.variant === "error"   && <AlertCircle  className="w-4 h-4 flex-shrink-0 text-danger" />}
          {t.variant === "info"    && <Info         className="w-4 h-4 flex-shrink-0 text-accent" />}
          <span className="flex-1">{t.message}</span>
          <button
            onClick={() => dismiss(t.id)}
            className="text-text-tertiary hover:text-text-primary flex-shrink-0 transition-colors"
            aria-label="Dismiss"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
