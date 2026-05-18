"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Copy, Check, Download, Settings, Zap, ArrowRight, FolderOpen } from "lucide-react";

interface ElectronBridge {
  prepareExtension?: (options?: { browserId?: string }) => Promise<{ ok: boolean; path?: string | null; browser?: string | null; error?: string }>;
}

const BROWSER_STORAGE_KEY = "recruitme.linkedinSetup.browserId";
const BROWSERS = [
  { id: "chrome", label: "Google Chrome" },
  { id: "opera", label: "Opera" },
  { id: "opera-gx", label: "Opera GX" },
  { id: "edge", label: "Microsoft Edge" },
  { id: "brave", label: "Brave" },
] as const;

function getElectronBridge(): ElectronBridge | null {
  if (typeof window === "undefined") return null;
  return (window as Window & { electron?: ElectronBridge }).electron ?? null;
}

export function LinkedInSetupPage() {
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  const [desktopReady, setDesktopReady] = useState(false);
  const [browserId, setBrowserId] = useState<(typeof BROWSERS)[number]["id"]>("chrome");
  const [prepareStatus, setPrepareStatus] = useState<{ tone: "ok" | "error"; message: string } | null>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
    setDesktopReady(typeof getElectronBridge()?.prepareExtension === "function");
    const storedBrowserId = window.localStorage.getItem(BROWSER_STORAGE_KEY);
    if (BROWSERS.some((browser) => browser.id === storedBrowserId)) {
      setBrowserId(storedBrowserId as (typeof BROWSERS)[number]["id"]);
    }
  }, []);

  async function handleCopyOrigin() {
    if (!origin) return;
    await navigator.clipboard.writeText(origin);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }

  async function handlePrepareExtension() {
    setPrepareStatus(null);
    const electron = getElectronBridge();
    if (typeof electron?.prepareExtension !== "function") {
      setPrepareStatus({ tone: "error", message: "This shortcut is only available in the desktop app." });
      return;
    }

    window.localStorage.setItem(BROWSER_STORAGE_KEY, browserId);
    const result = await electron.prepareExtension({ browserId });
    if (!result.ok) {
      setPrepareStatus({ tone: "error", message: result.error || "Could not prepare the extension folder." });
      return;
    }

    setPrepareStatus({
      tone: "ok",
      message: `Extension folder ready: ${result.path || "opened"}. ${result.browser ? `Opened ${result.browser}. ` : ""}Use Load unpacked once, then hit Reload here after future updates.`,
    });
  }

  return (
    <div className="max-w-2xl mx-auto py-10 px-6 space-y-5">
      <div>
        <Link href="/jobs" className="text-md text-text-secondary hover:text-text-primary flex items-center gap-1 transition-colors">
          ← Back to jobs
        </Link>
        <h1 className="text-xl font-semibold text-text-primary mt-3">LinkedIn Capture Setup</h1>
        <p className="text-text-secondary text-md mt-1">
          A small browser extension lets RecruitMe capture full LinkedIn profiles automatically — no copy-pasting required.
        </p>
      </div>

      {/* Step 1 — Download */}
      <div className="bg-surface-raised rounded-md border border-separator overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-3 border-b border-separator bg-surface-sunken">
          <span className="w-6 h-6 rounded-full bg-accent text-white text-xs font-semibold flex items-center justify-center flex-shrink-0 data-mono">1</span>
          <div className="flex items-center gap-2">
            <Download className="w-4 h-4 text-text-secondary" />
            <p className="text-md font-semibold text-text-primary">Download the extension</p>
          </div>
        </div>
        <div className="px-5 py-5 space-y-4">
          {desktopReady && (
            <label className="block space-y-1.5">
              <span className="text-md font-medium text-text-primary">Browser for automatic LinkedIn tabs</span>
              <select
                value={browserId}
                onChange={(event) => setBrowserId(event.target.value as (typeof BROWSERS)[number]["id"])}
                className="w-full bg-surface-sunken border border-separator rounded px-3 py-2 text-md text-text-primary"
              >
                {BROWSERS.map((browser) => (
                  <option key={browser.id} value={browser.id}>{browser.label}</option>
                ))}
              </select>
            </label>
          )}
          {desktopReady ? (
            <button
              type="button"
              onClick={handlePrepareExtension}
              className="flex items-center justify-center gap-2 w-full py-2.5 px-4 bg-accent hover:bg-accent-hover text-white rounded font-medium text-md transition-colors"
            >
              <FolderOpen className="w-4 h-4" />
              Prepare Extension Folder
            </button>
          ) : (
            <a
              href="/api/extension/download"
              download="recruitme-extension.zip"
              className="flex items-center justify-center gap-2 w-full py-2.5 px-4 bg-accent hover:bg-accent-hover text-white rounded font-medium text-md transition-colors"
            >
              <Download className="w-4 h-4" />
              Download RecruitMe Extension (.zip)
            </a>
          )}
          {prepareStatus && (
            <p className={`text-md ${prepareStatus.tone === "ok" ? "text-success" : "text-danger"}`}>
              {prepareStatus.message}
            </p>
          )}
          <div className="space-y-2 text-md text-text-secondary">
            <p className="font-medium text-text-primary">Load it into the same Chromium browser you selected above:</p>
            <ol className="space-y-1.5 list-decimal list-inside">
              <li>{desktopReady ? "Use the folder RecruitMe just opened" : "Unzip the downloaded file"}</li>
              <li>Go to <code className="bg-surface-sunken px-1.5 py-0.5 rounded text-xs text-text-primary font-mono">chrome://extensions</code> or your browser&apos;s extensions page</li>
              <li>Enable <strong>Developer mode</strong></li>
              <li>Click <strong>Load unpacked</strong> and select the unzipped folder</li>
              {desktopReady && <li>After updates, click <strong>Prepare Extension Folder</strong> again, then click <strong>Reload</strong> on the extension card</li>}
            </ol>
          </div>
        </div>
      </div>

      {/* Step 2 — Point at RecruitMe */}
      <div className="bg-surface-raised rounded-md border border-separator overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-3 border-b border-separator bg-surface-sunken">
          <span className="w-6 h-6 rounded-full bg-accent text-white text-xs font-semibold flex items-center justify-center flex-shrink-0 data-mono">2</span>
          <div className="flex items-center gap-2">
            <Settings className="w-4 h-4 text-text-secondary" />
            <p className="text-md font-semibold text-text-primary">Point the extension at RecruitMe</p>
          </div>
        </div>
        <div className="px-5 py-5 space-y-3">
          <p className="text-md text-text-secondary">
            Open the extension settings from your browser toolbar. Set the RecruitMe server URL to:
          </p>
          <div className="flex items-center gap-3 flex-wrap">
            <code className="flex-1 bg-surface-sunken px-3 py-2 rounded text-md text-text-primary font-mono min-w-0 break-all border border-separator">
              {origin || "https://your-app.up.railway.app"}
            </code>
            <button
              onClick={handleCopyOrigin}
              className="inline-flex items-center gap-2 h-8 px-3 rounded bg-surface-hover hover:bg-surface-overlay text-md text-text-primary border border-separator transition-colors flex-shrink-0"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <p className="text-md text-text-tertiary">
            Enter your RecruitMe username and password, then save and test the connection. The extension stores these settings locally in the browser and uses them to call your RecruitMe server.
          </p>
        </div>
      </div>

      {/* Step 3 — Use it */}
      <div className="bg-surface-raised rounded-md border border-separator overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-3 border-b border-separator bg-surface-sunken">
          <span className="w-6 h-6 rounded-full bg-accent text-white text-xs font-semibold flex items-center justify-center flex-shrink-0 data-mono">3</span>
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-text-secondary" />
            <p className="text-md font-semibold text-text-primary">Start capturing profiles</p>
          </div>
        </div>
        <div className="px-5 py-5">
          <div className="space-y-3">
            {[
              { label: "Automatic", desc: "Click Fetch profile on a candidate card. RecruitMe opens their LinkedIn page and the extension captures it automatically." },
              { label: "Manual", desc: "Browse to any LinkedIn profile, open the extension popup, choose a job, and click Import current profile." },
            ].map(({ label, desc }) => (
              <div key={label} className="flex gap-3">
                <ArrowRight className="w-4 h-4 text-accent flex-shrink-0 mt-0.5" />
                <p className="text-md text-text-secondary">
                  <span className="font-medium text-text-primary">{label} — </span>{desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-success-subtle border border-separator rounded-md px-5 py-4">
        <p className="text-md font-semibold text-success">Keep one browser contract</p>
        <p className="text-md text-text-secondary mt-1">
          For desktop auto-fetch, keep the extension loaded in the browser selected during setup. The extension can talk to desktop RecruitMe on whatever localhost port the app chose, but the server URL in extension settings must exactly match this page&apos;s URL.
        </p>
      </div>
    </div>
  );
}
