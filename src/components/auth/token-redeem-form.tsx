"use client";

/**
 * Shared form behind the two public auth-link pages:
 *   /join/[token]           → kind "invite": pick a username + password
 *   /reset-password/[token] → kind "reset":  set a new password
 *
 * Mirrors the login page's markup/tokens exactly — these are the only other
 * unauthenticated screens in the app, and they should feel like one family.
 */

import { useEffect, useState } from "react";
import { Users, Loader2, CheckCircle2 } from "lucide-react";

type Kind = "invite" | "reset";

interface TokenInfo {
  valid: boolean;
  kind?: Kind;
  orgName?: string | null;
  role?: string;
  username?: string;
}

export function TokenRedeemForm({ kind, token }: { kind: Kind; token: string }) {
  const [info, setInfo] = useState<TokenInfo | null>(null);
  const [checked, setChecked] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/auth-tokens/${encodeURIComponent(token)}`, { cache: "no-store" })
      .then((r) => r.json().catch(() => ({ valid: false })))
      .then((data) => {
        if (cancelled) return;
        setInfo(data);
        setChecked(true);
      })
      .catch(() => {
        if (cancelled) return;
        setInfo({ valid: false });
        setChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/auth-tokens/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(kind === "invite" ? { username: username.trim(), password } : { password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          typeof body.error === "string"
            ? body.error
            : body.error?.fieldErrors
              ? Object.values(body.error.fieldErrors as Record<string, string[]>).flat()[0]
              : "Something went wrong — ask for a fresh link.";
        setError(msg ?? "Something went wrong — ask for a fresh link.");
        setLoading(false);
        return;
      }
      setDone(true);
      setTimeout(() => window.location.replace("/login"), 1800);
    } catch {
      setError("Network error — try again.");
      setLoading(false);
    }
  };

  const heading = kind === "invite" ? "Create your account" : "Set a new password";
  const inputClass =
    "w-full h-7 px-2.5 rounded bg-surface-sunken border border-separator text-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus transition-all";

  return (
    <div className="min-h-screen bg-surface-base flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2.5 mb-6">
          <div className="w-8 h-8 bg-accent rounded-md flex items-center justify-center">
            <Users className="w-4 h-4 text-white" />
          </div>
          <div>
            <div className="text-text-primary font-semibold text-md leading-tight">RecruitMe</div>
            <div className="text-text-tertiary text-xs">Talent Manager</div>
          </div>
        </div>

        <div className="bg-surface-raised border border-separator rounded-xl p-6 w-full max-w-sm shadow-overlay">
          {!checked ? (
            <div className="flex items-center gap-2 text-text-secondary text-md">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking link…
            </div>
          ) : !info?.valid ? (
            <>
              <h1 className="text-text-primary font-semibold text-md mb-2">This link isn&apos;t valid</h1>
              <p className="text-xs text-text-secondary">
                It may have expired or already been used. Ask whoever sent it for a fresh one.
              </p>
            </>
          ) : done ? (
            <div className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-success mt-0.5" />
              <div>
                <h1 className="text-text-primary font-semibold text-md mb-1">
                  {kind === "invite" ? "Account created" : "Password updated"}
                </h1>
                <p className="text-xs text-text-secondary">Taking you to sign in…</p>
              </div>
            </div>
          ) : (
            <>
              <h1 className="text-text-primary font-semibold text-md mb-1">{heading}</h1>
              <p className="text-xs text-text-tertiary mb-4">
                {kind === "invite"
                  ? info.orgName
                    ? `You've been invited to join ${info.orgName}.`
                    : "You've been invited to RecruitMe."
                  : `Setting a new password for ${info.username}.`}
              </p>

              <form onSubmit={handleSubmit} className="space-y-3">
                {kind === "invite" && (
                  <div>
                    <label htmlFor="tk-username" className="block text-xs font-medium text-text-secondary mb-1">
                      Username
                    </label>
                    <input
                      id="tk-username"
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      autoComplete="username"
                      autoFocus
                      placeholder="Pick a username"
                      className={inputClass}
                    />
                  </div>
                )}
                <div>
                  <label htmlFor="tk-password" className="block text-xs font-medium text-text-secondary mb-1">
                    {kind === "invite" ? "Password" : "New password"}
                  </label>
                  <input
                    id="tk-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                    autoFocus={kind === "reset"}
                    placeholder="At least 8 characters, incl. a number or symbol"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label htmlFor="tk-confirm" className="block text-xs font-medium text-text-secondary mb-1">
                    Confirm password
                  </label>
                  <input
                    id="tk-confirm"
                    type="password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    autoComplete="new-password"
                    placeholder="Same again"
                    className={inputClass}
                  />
                </div>

                {error && (
                  <p role="alert" className="text-xs text-danger bg-danger-subtle border border-separator rounded px-2.5 py-1.5">
                    {error}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={loading || !password || !confirm || (kind === "invite" && !username.trim())}
                  className="w-full inline-flex items-center justify-center gap-1.5 h-7 px-3 rounded bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-text-inverse font-medium text-md transition-colors"
                >
                  {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {loading ? "Saving…" : kind === "invite" ? "Create account" : "Set password"}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
