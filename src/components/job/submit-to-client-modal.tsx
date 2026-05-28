"use client";

import { useEffect, useState } from "react";
import { X, Send } from "lucide-react";
import { showToast } from "@/components/ui/toast";

interface Candidate {
  id: string;
  name: string;
  matchScore: number | null;
}

interface Client {
  id: string;
  name: string;
}

interface SubmitToClientModalProps {
  jobId: string;
  candidate: Candidate;
  onClose: () => void;
  onSubmitted?: () => void;
}

export function SubmitToClientModal({ jobId, candidate, onClose, onSubmitted }: SubmitToClientModalProps) {
  const [clients, setClients] = useState<Client[]>([]);
  const [clientId, setClientId] = useState<string>("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch("/api/clients")
      .then(r => r.ok ? r.json() : [])
      .then((data: Client[]) => {
        setClients(data);
        if (data.length === 1) setClientId(data[0].id);
      })
      .catch(() => {});
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/submissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candidateId: candidate.id,
          clientId: clientId || null,
          matchScore: candidate.matchScore,
          notes: notes.trim() || null,
        }),
      });
      if (res.ok) {
        showToast(`${candidate.name} submitted to client`, "success");
        onSubmitted?.();
        onClose();
      } else {
        const body = await res.json().catch(() => ({}));
        showToast(body.error ?? "Submission failed", "error");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <h2 className="font-semibold text-gray-900">Submit to Client</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div className="p-3 bg-gray-50 rounded-lg">
            <p className="text-sm font-medium text-gray-900">{candidate.name}</p>
            {candidate.matchScore != null && (
              <p className="text-xs text-gray-500 mt-0.5">Match score: {candidate.matchScore}%</p>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Client</label>
            {clients.length === 0 ? (
              <p className="text-xs text-gray-400">
                No clients — <a href="/clients" className="text-blue-600 hover:underline">add a client first</a>
              </p>
            ) : (
              <select
                value={clientId}
                onChange={e => setClientId(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">— select client —</option>
                {clients.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Notes (optional)</label>
            <textarea
              rows={3}
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Any context for the client about this candidate…"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            />
          </div>

          <div className="flex gap-2 justify-end pt-1">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              <Send className="w-3.5 h-3.5" />
              {submitting ? "Submitting…" : "Submit candidate"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
