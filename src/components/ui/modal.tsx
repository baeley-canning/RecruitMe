"use client";

import { useEffect, useRef } from "react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /** Accessible label for screen readers. Required for WCAG. */
  labelledBy?: string;
  /** When false, ESC and backdrop click are ignored. Use during async work. */
  dismissable?: boolean;
  className?: string;
}

// Reusable modal shell with focus trap, ESC dismiss, and return-focus.
// Replaces ad-hoc div-as-modal patterns scattered across the app — those
// implementations were inconsistent on accessibility (some had ESC handling,
// none had focus trap or return-focus).
export function Modal({ open, onClose, children, labelledBy, dismissable = true, className }: ModalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Capture the focused element when the modal opens, restore on close.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    // Move initial focus into the modal so the screen reader announces it
    // and keyboard tabbing stays within.
    const firstFocusable = containerRef.current?.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    firstFocusable?.focus();
    return () => {
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  // ESC dismiss + focus trap on Tab.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissable) {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const focusables = Array.from(
        containerRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) ?? []
      ).filter((el) => el.offsetParent !== null);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last  = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose, dismissable]);

  if (!open) return null;

  // Backdrop: translucent black layer over the page. The dialog itself sits
  // on surface-overlay (#2c2c2e) with rounded-xl + shadow-overlay — the one
  // place we lean on a real shadow because the modal is genuinely floating.
  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-[1210] p-4"
      onClick={() => { if (dismissable) onClose(); }}
      role="presentation"
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={className ?? "bg-surface-overlay text-text-primary rounded-xl shadow-overlay w-full max-w-2xl max-h-[90vh] flex flex-col"}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
