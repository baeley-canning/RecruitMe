"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Copy, Check, Puzzle } from "lucide-react";

const EXTENSION_FOLDER = "browser-companion/recruitme-opera-linkedin-capture";

export default function LinkedInSetupPage() {
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  async function handleCopyOrigin() {
    if (!origin) return;
    await navigator.clipboard.writeText(origin);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }

  return (
    <div className="max-w-3xl mx-auto py-10 px-6 space-y-6">
      <div>
        <Link href="/jobs" className="text-sm text-teal-700 hover:underline">
          ← Back to jobs
        </Link>
        <h1 className="text-2xl font-bold text-slate-900 mt-3">LinkedIn Capture Setup</h1>
        <p className="text-slate-500 text-sm mt-1">
          RecruitMe now uses an Opera/Chromium extension for LinkedIn profile capture. This is more reliable than the old bookmarklet because the extension can read the rendered LinkedIn page and send it back to RecruitMe without relying on page-level fetch or popup handoffs.
        </p>
      </div>

      <div className="bg-white rounded-xl border border-teal-200 p-6 space-y-4">
        <div className="flex items-center gap-2 text-teal-700">
          <Puzzle className="w-5 h-5" />
          <p className="text-sm font-semibold uppercase tracking-wide">Step 1 — Load the extension</p>
        </div>
        <ol className="text-sm text-slate-700 space-y-2 list-decimal list-inside">
          <li>Open <strong>Opera extensions</strong> at <code className="bg-slate-100 px-1.5 py-0.5 rounded">opera://extensions</code>.</li>
          <li>Turn on <strong>Developer mode</strong>.</li>
          <li>Click <strong>Load unpacked</strong>.</li>
          <li>Select the extension folder in this repo:</li>
        </ol>
        <div className="rounded-lg bg-slate-900 text-slate-100 px-4 py-3 text-sm font-mono">
          {EXTENSION_FOLDER}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
        <p className="text-sm font-semibold text-slate-900">Step 2 — Point the extension at RecruitMe</p>
        <p className="text-sm text-slate-600">
          Open the extension popup once and make sure the server URL matches your RecruitMe app. The default is usually correct:
        </p>
        <div className="flex items-center gap-3 flex-wrap">
          <code className="bg-slate-100 px-3 py-2 rounded text-sm text-slate-700">{origin || "http://localhost:3000"}</code>
          <button
            onClick={handleCopyOrigin}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-sm text-slate-700 transition-colors"
          >
            {copied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
            {copied ? "Copied" : "Copy URL"}
          </button>
        </div>
        <p className="text-sm text-slate-600">
          If RecruitMe prompts you for a username and password in the browser, save those same credentials in the extension popup as well. The extension cannot reuse the browser's HTTP Basic auth automatically.
        </p>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-6">
        <p className="text-sm font-semibold text-slate-900 mb-3">Step 3 — Use it</p>
        <ol className="text-sm text-slate-700 space-y-2 list-decimal list-inside">
          <li>In RecruitMe, click <strong>Fetch profile</strong> on a candidate card.</li>
          <li>RecruitMe opens LinkedIn and creates a pending capture session.</li>
          <li>The Opera extension detects that pending session and captures the full rendered profile automatically.</li>
          <li>RecruitMe receives the profile text, stores it on the candidate, and rescoring runs from that richer profile instead of the SerpAPI snippet.</li>
        </ol>
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-xl p-5">
        <p className="text-sm font-semibold text-amber-800">Manual import is still available</p>
        <p className="text-sm text-amber-700 mt-1">
          If you are already on a LinkedIn profile and want to import it manually, open the extension popup, choose a job, and click <strong>Import current LinkedIn profile</strong>.
        </p>
      </div>
    </div>
  );
}
