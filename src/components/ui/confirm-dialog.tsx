"use client";

import { useEffect, useState, useCallback } from "react";
import { Modal } from "./modal";
import { cn } from "@/lib/utils";

export interface ConfirmOpts {
  title?: string;
  message: string;
  /** Action button label. Defaults to "Confirm". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** When true, the action button takes the danger style + has destructive
   *  semantics. Set this for delete / revoke / remove flows. */
  danger?: boolean;
}

// Imperative API mirrors showToast — anywhere in client code:
//   if (!await confirm({ message: "Delete this?" })) return;
// A single <ConfirmDialogHost/> mounted at the app root handles render.
let pendingResolve: ((v: boolean) => void) | null = null;
let listener: ((opts: ConfirmOpts) => void) | null = null;

export function confirm(opts: ConfirmOpts): Promise<boolean> {
  // If a confirm is already open, immediately resolve the prior one as
  // cancel so we never strand a Promise (rare — UI should prevent double-
  // open, but the fallback keeps us safe).
  if (pendingResolve) pendingResolve(false);
  return new Promise<boolean>((resolve) => {
    pendingResolve = resolve;
    listener?.(opts);
  });
}

export function ConfirmDialogHost() {
  const [opts, setOpts] = useState<ConfirmOpts | null>(null);

  useEffect(() => {
    listener = (o) => setOpts(o);
    return () => { listener = null; };
  }, []);

  const close = useCallback((value: boolean) => {
    if (pendingResolve) { pendingResolve(value); pendingResolve = null; }
    setOpts(null);
  }, []);

  if (!opts) return null;

  return (
    <Modal
      open
      onClose={() => close(false)}
      labelledBy="confirm-dialog-title"
      className="bg-surface-overlay border border-separator rounded-xl w-full max-w-md mx-4 shadow-overlay"
    >
      <div className="px-5 py-4 border-b border-separator">
        <h2 id="confirm-dialog-title" className="text-md font-semibold text-text-primary">
          {opts.title ?? "Are you sure?"}
        </h2>
      </div>
      <div className="px-5 py-4">
        <p className="text-base text-text-secondary leading-relaxed whitespace-pre-line">
          {opts.message}
        </p>
      </div>
      <div className="px-5 py-3 border-t border-separator flex items-center justify-end gap-2">
        <button
          onClick={() => close(false)}
          className="h-8 px-3 rounded bg-surface-hover hover:bg-[#3a3a3c] text-text-primary text-md border border-separator transition-colors"
        >
          {opts.cancelLabel ?? "Cancel"}
        </button>
        <button
          onClick={() => close(true)}
          autoFocus
          className={cn(
            "h-8 px-3 rounded text-white text-md font-medium transition-colors",
            opts.danger
              ? "bg-danger hover:bg-danger/90"
              : "bg-accent hover:bg-accent-hover",
          )}
        >
          {opts.confirmLabel ?? "Confirm"}
        </button>
      </div>
    </Modal>
  );
}
