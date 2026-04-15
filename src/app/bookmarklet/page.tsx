"use client";

import { useEffect, useRef, useState } from "react";
import { Copy, Check, Bookmark } from "lucide-react";
import Link from "next/link";

// Bookmarklet fallback — used when opener is detected it skips the picker and
// posts profile text directly back. Used standalone it shows the job picker.
function buildBookmarkletHref(base: string): string {
  const js =
    "(function(){" +
    "var B=" + JSON.stringify(base) + ";" +
    "if(!location.hostname.includes('linkedin.com')||!location.pathname.match(/\\/in\\//)){" +
    "alert('RecruitMe: Open a LinkedIn profile page first.');return;" +
    "}" +
    "function T(){var m=document.querySelector('main');return(m?m.innerText:document.body.innerText).slice(0,15000);}" +
    // ── Fetch-Profile mode ──────────────────────────────────────────────────
    // Opened by the "Fetch Profile" button via window.open(url,'rm-fetch').
    // LinkedIn's COOP kills window.opener and their CSP blocks fetch() to us,
    // so we use window.name (survives cross-origin navigation) + navigation.
    "if(window.name==='rm-fetch'){" +
    "var sov=document.createElement('div');" +
    "sov.style.cssText='position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(7,14,30,.85);z-index:2147483647;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;';" +
    "var sbx=document.createElement('div');" +
    "sbx.style.cssText='background:#fff;border-radius:12px;padding:32px 40px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.4);';" +
    "sbx.innerHTML='<div style=\"font-size:40px;margin-bottom:12px;color:#16a34a\">&#10003;</div><h2 style=\"margin:0 0 8px;font-size:18px;font-weight:700;color:#111\">Captured \u2014 sending to RecruitMe</h2><p style=\"margin:0;font-size:13px;color:#888\">Redirecting\u2026</p>';" +
    "sov.appendChild(sbx);document.body.appendChild(sov);" +
    // Pack profile data into window.name then navigate to our return page.
    // window.name survives cross-origin navigation; return page reads it and
    // broadcasts via BroadcastChannel to the job tab.
    "window.name=JSON.stringify({type:'recruitme-profile',profileText:T(),linkedinUrl:location.href.replace(/[?#].*/,'')});" +
    "location.href=B+'/bookmarklet/return';" +
    "return;" +
    "}" +
    // ── Standalone mode (job picker) ────────────────────────────────────────
    // Note: fetch() to our server is blocked by LinkedIn's CSP (connect-src).
    // This path only works when the bookmarklet is used from a non-LinkedIn
    // origin or from localhost.  On LinkedIn it will fail gracefully.
    "fetch(B+'/api/bookmarklet/jobs')" +
    ".then(function(r){return r.json();})" +
    ".then(function(jobs){" +
    "if(!jobs.length){alert('RecruitMe: No active jobs. Create one first.');return;}" +
    "var ov=document.createElement('div');" +
    "ov.style.cssText='position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.65);z-index:2147483647;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,BlinkMacSystemFont,sans-serif;';" +
    "var bx=document.createElement('div');" +
    "bx.style.cssText='background:#fff;border-radius:12px;padding:28px;width:440px;max-width:92vw;box-shadow:0 24px 64px rgba(0,0,0,.45);';" +
    "var h2=document.createElement('h2');" +
    "h2.style.cssText='margin:0 0 3px;font-size:18px;font-weight:700;color:#111;';" +
    "h2.textContent='Add to RecruitMe';" +
    "var sub=document.createElement('p');" +
    "sub.style.cssText='margin:0 0 16px;font-size:13px;color:#888;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';" +
    "var h1=document.querySelector('h1');" +
    "sub.textContent=h1?h1.innerText.split('\\n')[0].trim():location.hostname;" +
    "var sel=document.createElement('select');" +
    "sel.style.cssText='width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;color:#111;margin-bottom:14px;background:#fff;outline:none;';" +
    "jobs.forEach(function(j){var op=document.createElement('option');op.value=j.id;op.textContent=j.title+' \\u2014 '+j.company+' ('+j.candidateCount+')';sel.appendChild(op);});" +
    "var btn=document.createElement('button');" +
    "btn.style.cssText='width:100%;padding:12px;background:#7c3aed;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;';" +
    "btn.textContent='Import Candidate';" +
    "var cnl=document.createElement('button');" +
    "cnl.style.cssText='display:block;width:100%;padding:8px;margin-top:6px;background:none;border:none;color:#9ca3af;font-size:13px;cursor:pointer;';" +
    "cnl.textContent='Cancel';" +
    "var st=document.createElement('div');" +
    "st.style.cssText='font-size:13px;margin-top:10px;min-height:18px;color:#666;';" +
    "bx.appendChild(h2);bx.appendChild(sub);bx.appendChild(sel);bx.appendChild(btn);bx.appendChild(cnl);bx.appendChild(st);" +
    "ov.appendChild(bx);document.body.appendChild(ov);" +
    "function close(){ov.remove();}" +
    "cnl.onclick=close;" +
    "ov.onclick=function(e){if(e.target===ov)close();};" +
    "btn.onclick=function(){" +
    "if(btn.disabled)return;" +
    "btn.disabled=true;btn.textContent='Importing\\u2026';st.textContent='';st.style.color='#666';" +
    "fetch(B+'/api/bookmarklet/import',{" +
    "method:'POST'," +
    "headers:{'Content-Type':'application/json'}," +
    "body:JSON.stringify({jobId:sel.value,linkedinUrl:location.href.split('?')[0],profileText:T()})" +
    "})" +
    ".then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d};});})" +
    ".then(function(res){" +
    "if(res.ok){" +
    "btn.textContent=res.d.updated?'Updated \\u2713':'Imported \\u2713';" +
    "btn.style.background='#16a34a';" +
    "st.textContent='\\u2713 Saved. AI is scoring in the background.';" +
    "setTimeout(close,2500);" +
    "}else{" +
    "btn.disabled=false;btn.textContent='Import Candidate';" +
    "st.style.color='#dc2626';st.textContent='Error: '+(res.d.error||'Unknown error');" +
    "}" +
    "})" +
    ".catch(function(){" +
    "btn.disabled=false;btn.textContent='Import Candidate';" +
    "st.style.color='#dc2626';st.textContent='Cannot connect \\u2014 is RecruitMe running?';" +
    "});" +
    "};" +
    "})" +
    ".catch(function(){alert('RecruitMe: Cannot connect to '+B+'.');});" +
    "})();";

  return "javascript:" + encodeURIComponent(js);
}

export default function LinkedInSetupPage() {
  const linkRef = useRef<HTMLAnchorElement>(null);
  const [copied, setCopied] = useState(false);
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    const base = window.location.origin;
    setOrigin(base);
    if (linkRef.current) {
      linkRef.current.href = buildBookmarkletHref(base);
    }
  }, []);

  function handleCopyBookmarklet() {
    if (!origin) return;
    navigator.clipboard.writeText(buildBookmarkletHref(origin)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  }

  return (
    <div className="max-w-2xl mx-auto py-10 px-6 space-y-5">

      {/* Header */}
      <div>
        <Link href="/jobs" className="text-sm text-violet-600 hover:underline">
          ← Back to jobs
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-3">LinkedIn Setup</h1>
        <p className="text-gray-500 text-sm mt-1">
          Set this up once. After that, <strong>Fetch profile</strong> opens LinkedIn in a new tab — click the bookmark, tab closes itself, candidate is scored.
        </p>
      </div>

      {/* Step 1 — Install the bookmark */}
      <div className="bg-white rounded-xl border-2 border-violet-200 p-6">
        <p className="text-xs font-semibold text-violet-600 uppercase tracking-widest mb-1">Step 1 — Install once</p>
        <h2 className="font-semibold text-gray-900 mb-4">Add the bookmark to your bar</h2>

        <div className="flex items-center gap-3 flex-wrap mb-5">
          {/* eslint-disable-next-line jsx-a11y/anchor-is-valid */}
          <a
            ref={linkRef}
            href="#"
            draggable
            className="inline-flex items-center gap-2 px-5 py-3 bg-violet-600 hover:bg-violet-700 text-white rounded-lg font-semibold text-sm shadow-sm cursor-grab active:cursor-grabbing select-none transition-colors"
          >
            <Bookmark size={15} />
            Add to RecruitMe
          </a>
          <button
            onClick={handleCopyBookmarklet}
            className="inline-flex items-center gap-2 px-4 py-3 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-sm font-medium transition-colors"
          >
            {copied ? <Check size={15} className="text-green-600" /> : <Copy size={15} />}
            {copied ? "Copied!" : "Copy code"}
          </button>
        </div>

        <div className="space-y-3">
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
            <p className="text-sm font-medium text-slate-700 mb-1">Drag to bookmarks bar</p>
            <p className="text-sm text-slate-500">
              Drag the purple button above into your bookmarks bar. If the bar isn&apos;t visible, press <kbd className="bg-slate-200 rounded px-1 font-mono text-xs">Ctrl+Shift+B</kbd>.
            </p>
          </div>

          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 space-y-2">
            <p className="text-sm font-medium text-amber-800">Drag not working? (Opera)</p>
            <p className="text-sm text-amber-700">
              <strong>Option A:</strong> Right-click <strong>Add to RecruitMe</strong> above → <strong>Add link to bookmarks</strong> → folder: <strong>Bookmarks bar</strong>
            </p>
            <p className="text-sm text-amber-700">
              <strong>Option B:</strong> Click <strong>Copy code</strong> → press <kbd className="bg-amber-100 border border-amber-300 rounded px-1 font-mono text-xs">Ctrl+D</kbd> on any page → expand options → clear the URL field → paste → save to Bookmarks bar
            </p>
          </div>
        </div>
      </div>

      {/* Step 2 — How to use */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <p className="text-xs font-semibold text-violet-600 uppercase tracking-widest mb-1">Step 2 — Using it</p>
        <h2 className="font-semibold text-gray-900 mb-3">How it works</h2>
        <ol className="text-sm text-gray-600 space-y-2 list-decimal list-inside">
          <li>Click <strong>Fetch profile</strong> on any candidate card in RecruitMe</li>
          <li>Their LinkedIn profile opens in a new tab (bookmarks bar is visible)</li>
          <li>Click <strong>Add to RecruitMe</strong> in the bookmarks bar</li>
          <li>The tab captures the profile, sends it back, and closes itself</li>
          <li>The candidate card updates and rescores automatically</li>
        </ol>
      </div>

      {/* Origin info */}
      {origin && (
        <p className="text-xs text-center text-gray-400">
          Bookmark configured for{" "}
          <code className="font-mono bg-gray-100 px-1.5 py-0.5 rounded text-gray-500">{origin}</code>
          {" — "}reinstall if you change the server address.
        </p>
      )}
    </div>
  );
}
