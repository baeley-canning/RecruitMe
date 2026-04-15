"use client";

import { useEffect, useState } from "react";

export default function BookmarkletReturn() {
  const [status, setStatus] = useState<"sending" | "sent" | "error">("sending");

  useEffect(() => {
    let sent = false;
    try {
      const raw = window.name || "";
      window.name = ""; // clear immediately so stale data can't be re-read
      const data = JSON.parse(raw);
      if (data?.type === "recruitme-profile" && typeof data.profileText === "string" && data.profileText.length > 10) {
        const ch = new BroadcastChannel("recruitme-capture");
        ch.postMessage(data);
        ch.close();
        sent = true;
        setStatus("sent");
      }
    } catch {
      // malformed or empty window.name
    }
    if (!sent) setStatus("error");

    const t = setTimeout(() => {
      try { window.close(); } catch { /* ignore */ }
    }, 1500);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-white">
      <div className="text-center px-8 py-12">
        {status === "error" ? (
          <>
            <div className="text-5xl mb-4">✕</div>
            <h1 className="text-xl font-bold text-gray-900 mb-2">No profile data</h1>
            <p className="text-sm text-gray-500">Close this tab and try again from RecruitMe.</p>
          </>
        ) : (
          <>
            <div className="text-5xl mb-4" style={{ color: "#16a34a" }}>✓</div>
            <h1 className="text-xl font-bold text-gray-900 mb-2">Profile sent to RecruitMe</h1>
            <p className="text-sm text-gray-500">Closing tab…</p>
          </>
        )}
      </div>
    </div>
  );
}
