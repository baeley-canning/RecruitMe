"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Custom cursor for the Pulse tab — a small green water-drop that follows the
 * pointer with a soft ripple (a drop meeting water, on-theme for "Pulse"). It
 * hides the OS cursor while mounted and restores it on unmount/navigation, so
 * the effect is scoped to /pulse only. Position is written straight to a ref via
 * transform inside a rAF, so there's no React re-render per mousemove. The
 * breathe + ripple are flattened automatically for `prefers-reduced-motion`
 * (see globals.css), leaving a clean static drop. Skipped on touch devices.
 */
export function PulseCursor() {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    // No OS cursor to replace on touch / coarse pointers — leave them be.
    if (typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches) return;

    const prevCursor = document.body.style.cursor;
    document.body.style.cursor = "none";

    let raf = 0;
    let x = -100;
    let y = -100;
    let first = true;
    const render = () => {
      raf = 0;
      const el = ref.current;
      if (el) el.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
    };
    const onMove = (e: MouseEvent) => {
      x = e.clientX;
      y = e.clientY;
      if (first) { first = false; setShown(true); }
      if (!raf) raf = requestAnimationFrame(render);
    };
    const onLeave = () => setShown(false);
    const onEnter = () => setShown(true);

    window.addEventListener("mousemove", onMove, { passive: true });
    document.addEventListener("mouseleave", onLeave);
    document.addEventListener("mouseenter", onEnter);
    return () => {
      document.body.style.cursor = prevCursor;
      window.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseleave", onLeave);
      document.removeEventListener("mouseenter", onEnter);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden
      className={`pointer-events-none fixed left-0 top-0 z-[9999] transition-opacity duration-200 ${shown ? "opacity-100" : "opacity-0"}`}
    >
      <span className="relative flex h-4 w-4 items-center justify-center text-success">
        {/* ripple — the drop meeting water */}
        <span className="absolute inline-flex h-full w-full rounded-full bg-success opacity-20 animate-ping" />
        {/* the drop */}
        <svg
          viewBox="0 0 24 24"
          className="relative h-3.5 w-3.5 animate-breathe"
          style={{ filter: "drop-shadow(0 0 3px rgba(48, 209, 88, 0.6))" }}
        >
          <path d="M12 3 C12 3 5.5 11 5.5 15.5 a6.5 6.5 0 0 0 13 0 C18.5 11 12 3 12 3 Z" fill="currentColor" />
          {/* subtle gloss highlight for a watery sheen */}
          <ellipse cx="9.8" cy="14.4" rx="1.4" ry="2.2" fill="rgba(255,255,255,0.5)" transform="rotate(-18 9.8 14.4)" />
        </svg>
      </span>
    </div>
  );
}
