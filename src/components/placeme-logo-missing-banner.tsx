"use client";

import { useState } from "react";
import { AlertTriangle, X } from "lucide-react";

/**
 * Owner-only notice shown on the candidate-profiles page when neither
 * `public/placeme-logo.png` nor `public/placeme-logo.jpg` is present. The
 * .docx generator falls back to a styled "PlaceMe" wordmark placeholder
 * (see src/lib/generate-candidate-profile-doc.ts buildCoverPage). The
 * banner is rendered server-side only when the owner is viewing AND the
 * file is missing — dismissal lives in component state (per page load).
 */
export function PlaceMeLogoMissingBanner() {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  return (
    <div className="mb-3 rounded-md border border-warning/30 bg-warning-subtle overflow-hidden">
      <div className="flex items-start gap-2.5 px-3 py-2">
        <AlertTriangle className="w-3.5 h-3.5 text-warning flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-md font-medium text-warning-hover">
            PlaceMe logo isn&apos;t installed
          </p>
          <p className="text-xs text-warning-hover/80 mt-0.5">
            Upload <code className="font-mono">placeme-logo.png</code> (recommended:
            ~600×180px, transparent PNG) to the <code className="font-mono">public/</code>{" "}
            directory in the repo for branded covers. Until then, profiles render
            with a styled text placeholder.
          </p>
        </div>
        <button
          onClick={() => setDismissed(true)}
          className="h-7 w-7 rounded flex items-center justify-center text-warning hover:text-warning-hover hover:bg-surface-hover transition-colors flex-shrink-0"
          aria-label="Dismiss"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
