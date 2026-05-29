"use client";

import { useEffect, useState } from "react";
import { showToast } from "@/components/ui/toast";

interface WLConfig {
  logoUrl?:       string;
  brandName?:     string;
  primaryColour?: string;
  customDomain?:  string;
  footerText?:    string;
}

export default function WhiteLabelPage() {
  const [config, setConfig] = useState<WLConfig>({});
  const [form, setForm] = useState<WLConfig>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    fetch("/api/settings/white-label")
      .then(async (r) => {
        if (r.status === 403) { setForbidden(true); return; }
        const data = await r.json();
        setConfig(data);
        setForm(data);
      })
      .catch(() => showToast("Failed to load white-label settings", "error"))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const r = await fetch("/api/settings/white-label", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await r.json();
      if (!r.ok) {
        showToast(data.error || "Failed to save", "error");
        return;
      }
      setConfig(data);
      setForm(data);
      showToast("White-label settings saved", "success");
    } catch {
      showToast("Failed to save", "error");
    } finally {
      setSaving(false);
    }
  };

  const set = (field: keyof WLConfig) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  if (loading) return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;

  if (forbidden) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-8">
        <h1 className="text-xl font-semibold text-foreground">White-label Branding</h1>
        <div className="mt-4 border border-warning/30 bg-warning-subtle rounded-lg p-5">
          <p className="text-sm font-medium text-warning">Agency plan required</p>
          <p className="text-sm text-muted-foreground mt-1">
            White-label branding is available on the Agency plan ($999/mo). Includes custom logo,
            brand name, accent colour, custom domain, and footer text on exported reports.
          </p>
          <a
            href="/settings/billing"
            className="mt-3 inline-block text-xs font-medium text-accent border border-accent rounded px-3 py-1.5 hover:bg-accent/10 transition-colors"
          >
            View billing
          </a>
        </div>
      </div>
    );
  }

  const isDirty = JSON.stringify(form) !== JSON.stringify(config);

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-8">
      <div>
        <h1 className="text-xl font-semibold text-foreground">White-label Branding</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Customise how RecruitMe looks for your agency.
        </p>
      </div>

      <div className="border border-border rounded-lg divide-y divide-border">
        {/* Brand name */}
        <div className="p-5 space-y-2">
          <label className="text-sm font-medium text-foreground block">Brand name</label>
          <p className="text-xs text-muted-foreground">
            Shown in the sidebar and page titles instead of &ldquo;RecruitMe&rdquo;.
          </p>
          <input
            type="text"
            value={form.brandName ?? ""}
            onChange={set("brandName")}
            placeholder="e.g. TechRecruit NZ"
            maxLength={60}
            className="w-full h-8 px-3 rounded bg-surface-sunken border border-separator text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-accent transition-colors"
          />
        </div>

        {/* Logo URL */}
        <div className="p-5 space-y-2">
          <label className="text-sm font-medium text-foreground block">Logo URL</label>
          <p className="text-xs text-muted-foreground">
            HTTPS URL to your logo (SVG or PNG, max ~40px height recommended).
          </p>
          <input
            type="url"
            value={form.logoUrl ?? ""}
            onChange={set("logoUrl")}
            placeholder="https://yoursite.com/logo.svg"
            className="w-full h-8 px-3 rounded bg-surface-sunken border border-separator text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-accent transition-colors"
          />
          {form.logoUrl && (
            <div className="pt-1">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={form.logoUrl} alt="Logo preview" className="h-8 object-contain rounded" />
            </div>
          )}
        </div>

        {/* Primary colour */}
        <div className="p-5 space-y-2">
          <label className="text-sm font-medium text-foreground block">Primary accent colour</label>
          <p className="text-xs text-muted-foreground">
            Hex colour used for buttons and active states (e.g. #1D4ED8).
          </p>
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={form.primaryColour || "#6366F1"}
              onChange={set("primaryColour")}
              className="h-8 w-12 rounded border border-separator bg-surface-sunken cursor-pointer p-0.5"
            />
            <input
              type="text"
              value={form.primaryColour ?? ""}
              onChange={set("primaryColour")}
              placeholder="#6366F1"
              maxLength={7}
              className="w-32 h-8 px-3 rounded bg-surface-sunken border border-separator text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-accent transition-colors"
            />
          </div>
        </div>

        {/* Custom domain */}
        <div className="p-5 space-y-2">
          <label className="text-sm font-medium text-foreground block">Custom domain</label>
          <p className="text-xs text-muted-foreground">
            Your branded domain for link sharing and email footers.
          </p>
          <input
            type="text"
            value={form.customDomain ?? ""}
            onChange={set("customDomain")}
            placeholder="recruit.yoursite.com"
            className="w-full h-8 px-3 rounded bg-surface-sunken border border-separator text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-accent transition-colors"
          />
        </div>

        {/* Footer text */}
        <div className="p-5 space-y-2">
          <label className="text-sm font-medium text-foreground block">Report footer text</label>
          <p className="text-xs text-muted-foreground">
            Appears at the bottom of exported shortlist reports (max 200 characters).
          </p>
          <input
            type="text"
            value={form.footerText ?? ""}
            onChange={set("footerText")}
            placeholder="e.g. Prepared by TechRecruit NZ · techrecruit.co.nz"
            maxLength={200}
            className="w-full h-8 px-3 rounded bg-surface-sunken border border-separator text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-accent transition-colors"
          />
        </div>
      </div>

      <div className="flex items-center justify-end gap-3">
        <button
          onClick={handleSave}
          disabled={saving || !isDirty}
          className="h-8 px-4 rounded bg-accent hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
  );
}
