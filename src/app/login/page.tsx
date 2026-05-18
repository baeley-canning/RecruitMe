"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { Users, Loader2 } from "lucide-react";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setLoading(true);
    setError("");

    try {
      await fetch("/api/session/clear", {
        method: "POST",
        cache: "no-store",
      });
    } catch {
      // Continue anyway: a failed cleanup should not block a normal login attempt.
    }

    const result = await signIn("credentials", {
      username: username.trim(),
      password,
      callbackUrl: "/jobs",
      redirect: false,
    });

    if (result?.error) {
      setError(
        result.error === "CredentialsSignin"
          ? "Invalid username or password."
          : result.error
      );
      setLoading(false);
    } else {
      // Compare parsed origins, not string prefixes — `startsWith` lets
      // `https://app.example.com.evil.com` masquerade as a same-origin URL.
      let target = "/jobs";
      if (result?.url) {
        try {
          const next = new URL(result.url, window.location.origin);
          if (next.origin === window.location.origin) target = next.pathname + next.search + next.hash;
        } catch { /* fall through to default */ }
      }
      window.location.replace(target);
    }
  };

  return (
    <div className="min-h-screen bg-surface-base flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Brand */}
        <div className="flex items-center justify-center gap-2.5 mb-6">
          <div className="w-8 h-8 bg-accent rounded-md flex items-center justify-center">
            <Users className="w-4 h-4 text-white" />
          </div>
          <div>
            <div className="text-text-primary font-semibold text-md leading-tight">RecruitMe</div>
            <div className="text-text-tertiary text-xs">Talent Manager</div>
          </div>
        </div>

        {/* Card */}
        <div className="bg-surface-raised border border-separator rounded-xl p-6 w-full max-w-sm shadow-overlay">
          <h1 className="text-text-primary font-semibold text-md mb-4">Sign in to your account</h1>

          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label htmlFor="login-username" className="block text-xs font-medium text-text-secondary mb-1">
                Username
              </label>
              <input
                id="login-username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
                placeholder="Enter your username"
                aria-describedby={error ? "login-error" : undefined}
                className="w-full h-7 px-2.5 rounded bg-surface-sunken border border-separator text-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus transition-all"
              />
            </div>

            <div>
              <label htmlFor="login-password" className="block text-xs font-medium text-text-secondary mb-1">
                Password
              </label>
              <input
                id="login-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                placeholder="Enter your password"
                aria-describedby={error ? "login-error" : undefined}
                className="w-full h-7 px-2.5 rounded bg-surface-sunken border border-separator text-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus transition-all"
              />
            </div>

            {error && (
              <p
                id="login-error"
                role="alert"
                className="text-xs text-danger bg-danger-subtle border border-separator rounded px-2.5 py-1.5"
              >
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading || !username.trim() || !password}
              className="w-full inline-flex items-center justify-center gap-1.5 h-7 px-3 rounded bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium text-md transition-colors"
            >
              {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
