"use client";

import { useEffect, useState } from "react";
import { Lock } from "lucide-react";
import type { Capability } from "@/lib/permissions";

interface Caps {
  isOwner: boolean;
  capabilities: string[];
}

// Module-level cache so every gated button doesn't refetch. One request per page
// load; grants take effect on the next load (server enforcement is immediate).
let cache: Caps | null = null;
let inflight: Promise<Caps> | null = null;

function load(): Promise<Caps> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = fetch("/api/me/capabilities", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<Caps>) : { isOwner: false, capabilities: [] }))
      .then((d) => (cache = d))
      .catch(() => ({ isOwner: false, capabilities: [] as string[] }));
  }
  return inflight;
}

/**
 * Client-side capability check for hiding/locking paid actions. `loading` is
 * true until the fetch resolves — callers should treat unknown as NOT allowed
 * so a credit action never flashes usable for a user who lacks it.
 */
export function usePermissions() {
  const [state, setState] = useState<Caps | null>(cache);
  useEffect(() => {
    let alive = true;
    if (!cache) load().then((c) => alive && setState(c));
    return () => { alive = false; };
  }, []);
  const can = (cap: Capability) => !!state && (state.isOwner || state.capabilities.includes(cap));
  return { isOwner: state?.isOwner ?? false, can, loading: state === null };
}

/**
 * Renders `children` when the user has `cap`; otherwise a small locked chip with
 * a tooltip. While permissions are still loading, renders nothing (avoids a
 * flash of an action the user may not have). The SERVER still enforces — this is
 * purely to keep the UI honest about what the user can do.
 */
export function CapabilityGate({
  cap,
  label,
  children,
}: {
  cap: Capability;
  label: string;
  children: React.ReactNode;
}) {
  const { can, loading } = usePermissions();
  if (loading) return null;
  if (can(cap)) return <>{children}</>;
  return (
    <span
      className="inline-flex items-center gap-1 h-7 px-2 rounded text-xs text-text-tertiary bg-surface-hover/60 cursor-not-allowed select-none"
      title={`Locked — ask an owner to grant "${label}" access`}
    >
      <Lock className="w-3.5 h-3.5" />
      <span className="hidden sm:inline">{label}</span>
    </span>
  );
}
