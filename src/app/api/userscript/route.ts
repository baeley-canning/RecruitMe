// Serves the Tampermonkey userscript for one-click LinkedIn profile capture.
// When a LinkedIn profile is opened via RecruitMe's "Fetch Profile" button,
// this script auto-captures the page text and posts it back to the opener tab.
export async function GET() {
  const script = `// ==UserScript==
// @name         RecruitMe — LinkedIn Profile Capture
// @namespace    recruitme
// @version      1.1
// @description  Automatically sends LinkedIn profile text to RecruitMe when opened via "Fetch Profile"
// @author       RecruitMe
// @match        https://www.linkedin.com/in/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // Only fire when this tab was opened by RecruitMe's "Fetch Profile" button
  if (!window.opener || window.opener === window) return;

  let sent = false;

  function tryCapture() {
    if (sent) return;

    var main = document.querySelector('main');
    var text = (main ? main.innerText : document.body.innerText).trim();

    // Wait until LinkedIn has rendered meaningful content
    if (text.length < 200) {
      setTimeout(tryCapture, 500);
      return;
    }

    sent = true;

    // Small toast in the bottom-right corner
    var toast = document.createElement('div');
    toast.style.cssText = [
      'position:fixed',
      'bottom:24px',
      'right:24px',
      'background:#7c3aed',
      'color:#fff',
      'border-radius:10px',
      'padding:14px 20px',
      'font-family:system-ui,-apple-system,sans-serif',
      'font-size:14px',
      'font-weight:600',
      'z-index:2147483647',
      'box-shadow:0 8px 24px rgba(0,0,0,.35)',
    ].join(';');
    toast.textContent = '\\u2713 Sending to RecruitMe\\u2026';
    document.body.appendChild(toast);

    window.opener.postMessage(
      {
        type: 'recruitme-profile',
        profileText: text.slice(0, 15000),
        linkedinUrl: location.href.split('?')[0],
      },
      '*'
    );

    setTimeout(function () {
      toast.textContent = '\\u2713 Done! Closing\\u2026';
      setTimeout(function () { window.close(); }, 900);
    }, 1600);
  }

  // Give LinkedIn's SPA ~1.5 s to render before reading
  setTimeout(tryCapture, 1500);
})();
`;

  return new Response(script, {
    headers: {
      "Content-Type": "application/javascript",
      // .user.js extension triggers Tampermonkey's auto-install dialog
      "Content-Disposition": 'attachment; filename="recruitme.user.js"',
    },
  });
}
