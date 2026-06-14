"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

/**
 * Root crash boundary. This REPLACES the root layout (and its globals.css
 * import), so Tailwind tokens / CSS vars aren't guaranteed to be loaded here —
 * inline styles with the dark-theme hex are the one legitimate exception to the
 * "tokens only" rule (same reasoning as the printable-PDF HTML string). Keeps
 * an unhandled crash on-brand instead of dropping to the bare white Next error.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
          backgroundColor: "#1a1a1c",
          color: "#f5f5f7",
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
        }}
      >
        <div style={{ textAlign: "center", maxWidth: 420 }}>
          <p
            style={{
              fontSize: 13,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "#6e6e73",
              margin: "0 0 16px",
            }}
          >
            Something went wrong
          </p>
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 8px" }}>
            The app hit an unexpected error
          </h1>
          <p style={{ fontSize: 14, color: "#a1a1a6", margin: "0 0 24px" }}>
            It&apos;s been logged. Try reloading — if it keeps happening, head
            back to your jobs.
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            <button
              onClick={() => reset()}
              style={{
                appearance: "none",
                border: "none",
                cursor: "pointer",
                height: 32,
                padding: "0 16px",
                borderRadius: 6,
                backgroundColor: "#0a84ff",
                color: "#ffffff",
                fontSize: 14,
                fontWeight: 500,
              }}
            >
              Reload
            </button>
            {/* Plain <a> on purpose: a full reload re-bootstraps the app after
                a crash; next/link would client-nav back into the broken tree. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a
              href="/jobs"
              style={{
                display: "inline-flex",
                alignItems: "center",
                height: 32,
                padding: "0 16px",
                borderRadius: 6,
                backgroundColor: "#232325",
                color: "#f5f5f7",
                fontSize: 14,
                fontWeight: 500,
                textDecoration: "none",
                border: "1px solid #323234",
              }}
            >
              Back to jobs
            </a>
          </div>
          {error.digest ? (
            <p style={{ fontSize: 12, color: "#6e6e73", marginTop: 20 }}>
              Reference: {error.digest}
            </p>
          ) : null}
        </div>
      </body>
    </html>
  );
}
