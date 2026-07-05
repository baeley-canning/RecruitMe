"use client";

/**
 * Guided onboarding wizard for the platform owner setting up a new customer
 * agency. It ORCHESTRATES the existing, individually-tested endpoints
 * (create org → invite link → scraper token) — no new server logic — so each
 * step is independently retryable. Owner-gated by the /admin layout.
 */

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Loader2, Building2, Link2, Cpu, CheckCircle2, Copy, Check, SkipForward, Rocket } from "lucide-react";

type Step = 1 | 2 | 3 | 4;

const INPUT =
  "w-full h-7 px-2.5 rounded bg-surface-sunken border border-separator text-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus transition-all";

function CopyRow({ value, mono = true }: { value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <input readOnly value={value} onFocus={(e) => e.currentTarget.select()} className={`${INPUT} ${mono ? "data-mono text-xs" : ""}`} />
      <button
        type="button"
        onClick={async () => { try { await navigator.clipboard.writeText(value); setCopied(true); } catch { /* selectable */ } }}
        className="h-7 px-2.5 rounded bg-accent hover:bg-accent-hover text-white text-md font-medium inline-flex items-center gap-1 transition-colors"
      >
        {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export default function OnboardWizard() {
  const [step, setStep] = useState<Step>(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Collected state
  const [orgName, setOrgName] = useState("");
  const [orgId, setOrgId] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [tokenLabel, setTokenLabel] = useState("");
  const [tokenValue, setTokenValue] = useState<string | null>(null);

  const go = (s: Step) => { setError(""); setStep(s); };

  async function createOrg(e: React.FormEvent) {
    e.preventDefault();
    if (!orgName.trim()) return;
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/admin/orgs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: orgName.trim() }),
      });
      const data = await res.json();
      if (res.status === 409) {
        // Org already exists — offer to continue with it rather than dead-end.
        const list = await fetch("/api/admin/orgs").then((r) => r.json()).catch(() => []);
        const found = Array.isArray(list) ? list.find((o: { name: string }) => o.name.toLowerCase() === orgName.trim().toLowerCase()) : null;
        if (found) { setOrgId(found.id); setTokenLabel(slug(orgName)); go(2); return; }
        setError("That organisation name is taken."); return;
      }
      if (!res.ok) { setError(typeof data.error === "string" ? data.error : "Could not create the organisation."); return; }
      setOrgId(data.id);
      setTokenLabel(slug(orgName));
      go(2);
    } catch { setError("Network error — try again."); }
    finally { setBusy(false); }
  }

  async function makeInvite() {
    if (!orgId) return;
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/admin/users/links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "invite", orgId, role: "user" }),
      });
      const data = await res.json();
      if (!res.ok) { setError(typeof data.error === "string" ? data.error : "Could not generate the invite link."); return; }
      setInviteUrl(data.url);
    } catch { setError("Network error — try again."); }
    finally { setBusy(false); }
  }

  async function mintToken() {
    if (!orgId) return;
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/admin/scraper-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: tokenLabel.trim() || slug(orgName), orgId }),
      });
      const data = await res.json();
      if (!res.ok) { setError(typeof data.error === "string" ? data.error : "Could not mint the token."); return; }
      setTokenValue(data.token);
    } catch { setError("Network error — try again."); }
    finally { setBusy(false); }
  }

  return (
    <div className="min-h-screen bg-surface-base">
      <div className="max-w-xl mx-auto px-4 py-8">
        <Link href="/admin" className="inline-flex items-center gap-1.5 text-md text-text-tertiary hover:text-text-primary transition-colors mb-6">
          <ArrowLeft className="w-3.5 h-3.5" /> Admin
        </Link>

        <div className="flex items-center gap-2.5 mb-1">
          <div className="w-8 h-8 rounded-lg bg-accent-subtle flex items-center justify-center">
            <Rocket className="w-4 h-4 text-accent" />
          </div>
          <h1 className="text-md font-semibold text-text-primary">Onboard an agency</h1>
        </div>
        <p className="text-xs text-text-tertiary mb-5">Set up a new customer org, invite their first user, and (optionally) connect their scraper box.</p>

        {/* Stepper */}
        <div className="flex items-center gap-1.5 mb-5">
          {[
            { n: 1, label: "Organisation", Icon: Building2 },
            { n: 2, label: "Invite", Icon: Link2 },
            { n: 3, label: "Scraper box", Icon: Cpu },
            { n: 4, label: "Done", Icon: CheckCircle2 },
          ].map(({ n, label, Icon }) => (
            <div key={n} className="flex items-center gap-1.5 flex-1">
              <div className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 ${step >= n ? "bg-accent text-white" : "bg-surface-hover text-text-tertiary"}`}>
                <Icon className="w-3 h-3" />
              </div>
              <span className={`text-2xs truncate ${step >= n ? "text-text-secondary" : "text-text-tertiary"}`}>{label}</span>
            </div>
          ))}
        </div>

        <div className="bg-surface-raised border border-separator rounded-xl p-5">
          {error && <p role="alert" className="text-xs text-danger bg-danger-subtle border border-separator rounded px-2.5 py-1.5 mb-3">{error}</p>}

          {step === 1 && (
            <form onSubmit={createOrg} className="space-y-3">
              <h2 className="text-md font-semibold text-text-primary">Create the organisation</h2>
              <p className="text-xs text-text-tertiary">Everyone in this org sees only its jobs and candidates.</p>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">Agency name</label>
                <input type="text" value={orgName} onChange={(e) => setOrgName(e.target.value)} autoFocus placeholder="e.g. Acme Recruitment" className={INPUT} />
              </div>
              <div className="flex justify-end">
                <button type="submit" disabled={busy || !orgName.trim()} className="h-7 px-3 rounded bg-accent hover:bg-accent-hover disabled:opacity-50 text-white text-md font-medium inline-flex items-center gap-1.5 transition-colors">
                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowRight className="w-3.5 h-3.5" />}
                  Create &amp; continue
                </button>
              </div>
            </form>
          )}

          {step === 2 && (
            <div className="space-y-3">
              <h2 className="text-md font-semibold text-text-primary">Invite their first user</h2>
              <p className="text-xs text-text-tertiary">
                Generate a single-use invite link for <span className="text-text-secondary font-medium">{orgName}</span>. They pick their own username and password — you never handle a credential.
              </p>
              {!inviteUrl ? (
                <button onClick={makeInvite} disabled={busy} className="h-7 px-3 rounded bg-accent hover:bg-accent-hover disabled:opacity-50 text-white text-md font-medium inline-flex items-center gap-1.5 transition-colors">
                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />}
                  Generate invite link
                </button>
              ) : (
                <>
                  <CopyRow value={inviteUrl} />
                  <p className="text-2xs text-text-tertiary">Send it over any channel you already share. Expires in 7 days.</p>
                </>
              )}
              <div className="flex justify-between pt-2">
                <button onClick={() => go(1)} className="h-7 px-3 rounded text-text-secondary hover:bg-surface-hover text-md inline-flex items-center gap-1.5">
                  <ArrowLeft className="w-3.5 h-3.5" /> Back
                </button>
                <button onClick={() => go(3)} className="h-7 px-3 rounded bg-accent hover:bg-accent-hover text-white text-md font-medium inline-flex items-center gap-1.5">
                  Next <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-3">
              <h2 className="text-md font-semibold text-text-primary">Connect a scraper box <span className="text-xs font-normal text-text-tertiary">(optional)</span></h2>
              <p className="text-xs text-text-tertiary">
                If this agency runs their own scraper mini-PC, mint a token locked to <span className="text-text-secondary font-medium">{orgName}</span>. That box can only ever touch their org&apos;s data. Skip if they&apos;re library-only for now.
              </p>
              {!tokenValue ? (
                <>
                  <div>
                    <label className="block text-xs font-medium text-text-secondary mb-1">Box label</label>
                    <input type="text" value={tokenLabel} onChange={(e) => setTokenLabel(e.target.value)} placeholder="e.g. acme-nuc-scraper" className={INPUT} />
                  </div>
                  <button onClick={mintToken} disabled={busy || !tokenLabel.trim()} className="h-7 px-3 rounded bg-accent hover:bg-accent-hover disabled:opacity-50 text-white text-md font-medium inline-flex items-center gap-1.5 transition-colors">
                    {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Cpu className="w-3.5 h-3.5" />}
                    Mint token
                  </button>
                </>
              ) : (
                <>
                  <p className="text-2xs text-text-tertiary">Copy this now — it&apos;s shown once. Set it on their box:</p>
                  <CopyRow value={`SCRAPER_API_TOKEN=${tokenValue}`} />
                </>
              )}
              <div className="flex justify-between pt-2">
                <button onClick={() => go(2)} className="h-7 px-3 rounded text-text-secondary hover:bg-surface-hover text-md inline-flex items-center gap-1.5">
                  <ArrowLeft className="w-3.5 h-3.5" /> Back
                </button>
                <button onClick={() => go(4)} className="h-7 px-3 rounded bg-accent hover:bg-accent-hover text-white text-md font-medium inline-flex items-center gap-1.5">
                  {tokenValue ? "Next" : <>Skip <SkipForward className="w-3.5 h-3.5" /></>}
                  {tokenValue && <ArrowRight className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="space-y-3">
              <div className="flex items-start gap-2">
                <CheckCircle2 className="w-5 h-5 text-success mt-0.5 flex-shrink-0" />
                <div>
                  <h2 className="text-md font-semibold text-text-primary">{orgName} is set up</h2>
                  <p className="text-xs text-text-tertiary mt-0.5">Here&apos;s what to do next.</p>
                </div>
              </div>
              <ul className="text-xs text-text-secondary space-y-1.5 list-disc pl-5">
                <li>{inviteUrl ? "Send the invite link so their first user can sign in." : "Generate an invite link (step 2) when you're ready to add their team."}</li>
                <li>Once they&apos;re in, they create a job by pasting a JD — it&apos;s parsed into must-haves and candidates get a free Fit score.</li>
                <li>Bulk-import their existing CVs, or run <span className="data-mono">npm run seed:demo</span> to show a populated demo org.</li>
                {tokenValue && <li>Their scraper box is connected — set the <span className="data-mono">SCRAPER_API_TOKEN</span> you copied.</li>}
              </ul>
              <div className="flex justify-between pt-2">
                <button onClick={() => { setStep(1); setOrgName(""); setOrgId(null); setInviteUrl(null); setTokenValue(null); setTokenLabel(""); }} className="h-7 px-3 rounded text-text-secondary hover:bg-surface-hover text-md">
                  Onboard another
                </button>
                <Link href="/admin" className="h-7 px-3 rounded bg-accent hover:bg-accent-hover text-white text-md font-medium inline-flex items-center gap-1.5">
                  Done <Check className="w-3.5 h-3.5" />
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Lowercase, hyphenated slug for default token/box labels. */
function slug(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") + "-scraper";
}
