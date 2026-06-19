import { cn } from "@/lib/utils";

export function LinkedInIcon({ className }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
    </svg>
  );
}

// Brand-mark icons for JobAdder + SEEK — clean rounded-square glyphs in each
// platform's colour (SEEK magenta, JobAdder teal), sized + shaped like the
// LinkedIn logo so the three links read as a consistent set. SEEK/JobAdder are
// wordmark brands with no single-glyph logo, so a tight letter mark ("SK"/"JA")
// in the brand colour is the recognisable icon.
export function JobAdderIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect width="24" height="24" rx="5" fill="#13b6a8" />
      <text x="12" y="16.6" textAnchor="middle" fontFamily="ui-sans-serif, system-ui, -apple-system, sans-serif" fontSize="10.5" fontWeight="700" letterSpacing="-0.5" fill="#ffffff">JA</text>
    </svg>
  );
}

export function SeekIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect width="24" height="24" rx="5" fill="#e6007e" />
      <text x="12" y="16.6" textAnchor="middle" fontFamily="ui-sans-serif, system-ui, -apple-system, sans-serif" fontSize="10.5" fontWeight="700" letterSpacing="-0.5" fill="#ffffff">SK</text>
    </svg>
  );
}

// JobAdder "JA" badge — shows when a candidate is linked in JobAdder
// Only render as a link if the URL is http(s). Anything else (javascript:,
// data:, vbscript:, etc.) would execute on click — those get the muted
// placeholder badge instead. The PATCH endpoint also rejects non-http(s)
// URLs, but this guard protects against any historical bad rows.
function isSafeHref(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export function JobAdderBadge({ url, className }: { url: string | null; className?: string }) {
  const safeUrl = url && isSafeHref(url) ? url : null;
  const base = cn(
    "inline-flex items-center justify-center w-5 h-5 rounded text-[9px] font-bold leading-none border transition-all",
    safeUrl
      // Linked: solid orange + clear hover affordances so it reads as a clickable link
      // (previously had only the implicit anchor — recruiters couldn't tell it was clickable).
      ? "bg-warning text-text-inverse border-warning cursor-pointer hover:opacity-80 hover:ring-2 hover:ring-warning/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      : "bg-surface-hover text-text-tertiary border-separator hover:text-warning",
    className,
  );
  if (safeUrl) {
    return (
      <a
        href={safeUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={base}
        title="Open in JobAdder"
        aria-label="Open in JobAdder"
      >
        JA
      </a>
    );
  }
  return <span className={base} aria-label="Not linked in JobAdder">JA</span>;
}

// SEEK "SK" badge — shows when a candidate has a SEEK profile URL attached.
// Mirrors JobAdderBadge exactly: only render as a link if the URL is http(s)
// (guarded by the same isSafeHref check); anything else gets the muted
// placeholder so a javascript:/data: URL can't execute on click.
export function SeekBadge({ url, className }: { url: string | null; className?: string }) {
  const safeUrl = url && isSafeHref(url) ? url : null;
  const base = cn(
    "inline-flex items-center justify-center w-5 h-5 rounded text-[9px] font-bold leading-none border transition-all",
    safeUrl
      ? "bg-warning text-text-inverse border-warning cursor-pointer hover:opacity-80 hover:ring-2 hover:ring-warning/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      : "bg-surface-hover text-text-tertiary border-separator hover:text-warning",
    className,
  );
  if (safeUrl) {
    return (
      <a
        href={safeUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={base}
        title="Open in SEEK"
        aria-label="Open in SEEK"
      >
        SK
      </a>
    );
  }
  return <span className={base} aria-label="Not linked in SEEK">SK</span>;
}
