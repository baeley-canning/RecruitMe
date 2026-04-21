"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Copy, Check, Download, Puzzle, Settings, Zap, ArrowRight } from "lucide-react";

export function LinkedInSetupPage() {
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
    <div className="max-w-2xl mx-auto py-10 px-6 space-y-5">
      <div>
        <Link href="/jobs" className="text-sm text-slate-500 hover:text-slate-700 flex items-center gap-1">
          ← Back to jobs
        </Link>
        <h1 className="text-2xl font-bold text-slate-900 mt-3">LinkedIn Capture Setup</h1>
        <p className="text-slate-500 text-sm mt-1">
          A small browser extension lets RecruitMe capture full LinkedIn profiles automatically — no copy-pasting required.
        </p>
      </div>

      {/* Step 1 — Download */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-100 bg-slate-50">
          <span className="w-6 h-6 rounded-full bg-blue-600 text-white text-xs font-bold flex items-center justify-center flex-shrink-0">1</span>
          <div className="flex items-center gap-2">
            <Download className="w-4 h-4 text-slate-500" />
            <p className="text-sm font-semibold text-slate-800">Download the extension</p>
          </div>
        </div>
        <div className="px-5 py-5 space-y-4">
          <a
            href="/api/extension/download"
            download="recruitme-extension.zip"
            className="flex items-center justify-center gap-2 w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium text-sm transition-colors"
          >
            <Download className="w-4 h-4" />
            Download RecruitMe Extension (.zip)
          </a>
          <div className="space-y-2 text-sm text-slate-600">
            <p className="font-medium text-slate-700">Load it into Opera or Chrome:</p>
            <ol className="space-y-1.5 list-decimal list-inside">
              <li>Unzip the downloaded file</li>
              <li>Go to <code className="bg-slate-100 px-1.5 py-0.5 rounded text-xs">opera://extensions</code> (or <code className="bg-slate-100 px-1.5 py-0.5 rounded text-xs">chrome://extensions</code>)</li>
              <li>Enable <strong>Developer mode</strong></li>
              <li>Click <strong>Load unpacked</strong> and select the unzipped folder</li>
            </ol>
          </div>
        </div>
      </div>

      {/* Step 2 — Point at RecruitMe */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-100 bg-slate-50">
          <span className="w-6 h-6 rounded-full bg-blue-600 text-white text-xs font-bold flex items-center justify-center flex-shrink-0">2</span>
          <div className="flex items-center gap-2">
            <Settings className="w-4 h-4 text-slate-500" />
            <p className="text-sm font-semibold text-slate-800">Point the extension at RecruitMe</p>
          </div>
        </div>
        <div className="px-5 py-5 space-y-3">
          <p className="text-sm text-slate-600">
            Click the extension icon in your browser toolbar. Set the server URL to:
          </p>
          <div className="flex items-center gap-3 flex-wrap">
            <code className="flex-1 bg-slate-100 px-3 py-2.5 rounded-lg text-sm text-slate-700 font-mono min-w-0 break-all">
              {origin || "https://your-app.up.railway.app"}
            </code>
            <button
              onClick={handleCopyOrigin}
              className="inline-flex items-center gap-2 px-3 py-2.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-sm text-slate-700 transition-colors flex-shrink-0"
            >
              {copied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <p className="text-sm text-slate-500">
            Enter your RecruitMe username and password in the popup too — this lets you pick a job for manual imports.
          </p>
        </div>
      </div>

      {/* Step 3 — Use it */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-100 bg-slate-50">
          <span className="w-6 h-6 rounded-full bg-blue-600 text-white text-xs font-bold flex items-center justify-center flex-shrink-0">3</span>
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-slate-500" />
            <p className="text-sm font-semibold text-slate-800">Start capturing profiles</p>
          </div>
        </div>
        <div className="px-5 py-5">
          <div className="space-y-3">
            {[
              { label: "Automatic", desc: "Click Fetch profile on a candidate card. RecruitMe opens their LinkedIn page and the extension captures it automatically." },
              { label: "Manual", desc: "Browse to any LinkedIn profile, open the extension popup, choose a job, and click Import current profile." },
            ].map(({ label, desc }) => (
              <div key={label} className="flex gap-3">
                <ArrowRight className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-slate-600">
                  <span className="font-medium text-slate-800">{label} — </span>{desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-5 py-4">
        <p className="text-sm font-semibold text-emerald-800">RecruitMe must be open in the same browser</p>
        <p className="text-sm text-emerald-700 mt-1">
          The extension and the app talk to each other through the browser. Keep your RecruitMe tab open in Opera or Chrome while capturing profiles.
        </p>
      </div>
    </div>
  );
}
