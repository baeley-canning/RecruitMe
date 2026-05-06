"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Sliders, BookmarkPlus, Trash2 } from "lucide-react";
import { ScoringWeightsEditor } from "@/components/scoring-weights-editor";
import type { ScoringWeights } from "@/lib/scoring-config";

interface JobScoringResponse {
  weights: ScoringWeights;
  defaults: ScoringWeights;       // platform defaults
  orgDefaults: ScoringWeights;    // org-level (what reset goes back to)
  hasOverride: boolean;
}

interface Preset {
  id: string;
  name: string;
  weights: string; // JSON
}

function safeParseWeights(json: string): ScoringWeights | null {
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object") return parsed as ScoringWeights;
  } catch { /* fallthrough */ }
  return null;
}

// Collapsible per-job override panel. Hidden by default — most jobs use the
// org defaults; this is for the cases where a recruiter wants to lean a
// specific role's scoring (e.g. "for this Sales Director role, location
// matters more than skills").
export function JobWeightsCard({ jobId }: { jobId: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<JobScoringResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [savingPreset, setSavingPreset] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [showSavePreset, setShowSavePreset] = useState(false);
  const [editorKey, setEditorKey] = useState(0);

  const refreshPresets = useCallback(async () => {
    try {
      const r = await fetch("/api/settings/scoring/presets");
      if (r.ok) setPresets((await r.json()) as Preset[]);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!open || loaded) return;
    fetch(`/api/jobs/${jobId}/scoring`)
      .then((r) => r.ok ? r.json() : null)
      .then((d: JobScoringResponse | null) => {
        setData(d);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    void refreshPresets();
  }, [open, loaded, jobId, refreshPresets]);

  const applyPreset = async (presetId: string) => {
    const preset = presets.find((p) => p.id === presetId);
    if (!preset) return;
    const w = safeParseWeights(preset.weights);
    if (!w) return;
    // Push the preset's weights to the per-job override, then reload the editor.
    await fetch(`/api/jobs/${jobId}/scoring`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(w),
    });
    setData((prev) => prev ? { ...prev, weights: w, hasOverride: true } : prev);
    setEditorKey((k) => k + 1); // force re-mount so the editor's internal state picks up new weights
  };

  const savePreset = async () => {
    if (!data || !presetName.trim()) return;
    setSavingPreset(true);
    try {
      await fetch("/api/settings/scoring/presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: presetName.trim(), weights: data.weights }),
      });
      setPresetName("");
      setShowSavePreset(false);
      await refreshPresets();
    } finally {
      setSavingPreset(false);
    }
  };

  const deletePreset = async (presetId: string) => {
    if (!confirm("Delete this preset?")) return;
    await fetch(`/api/settings/scoring/presets/${presetId}`, { method: "DELETE" });
    await refreshPresets();
  };

  return (
    <div className="mb-6 rounded-xl border border-slate-200 bg-white overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-50 text-left"
      >
        <div className="flex items-center gap-2">
          <Sliders className="w-4 h-4 text-slate-400" />
          <span className="text-sm font-medium text-slate-700">Scoring weights for this job</span>
          {data?.hasOverride && (
            <span className="text-[10px] uppercase tracking-wide font-semibold bg-blue-50 text-blue-700 border border-blue-200 rounded-full px-2 py-0.5">
              Custom
            </span>
          )}
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
      </button>

      {open && (
        <div className="border-t border-slate-100 p-4">
          {!loaded && <p className="text-xs text-slate-400">Loading…</p>}
          {loaded && data && (
            <>
              <p className="text-xs text-slate-500 mb-4">
                Override scoring weights just for this job. Reset returns to your org-level defaults.
              </p>

              {/* Preset bar — apply a saved preset, or save the current weights as one */}
              <div className="mb-4 flex items-center gap-2 flex-wrap p-3 rounded-lg bg-slate-50 border border-slate-200">
                <span className="text-xs font-medium text-slate-600">Preset:</span>
                <select
                  onChange={(e) => { if (e.target.value) void applyPreset(e.target.value); }}
                  defaultValue=""
                  className="text-xs border border-slate-200 rounded-md px-2 py-1 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="" disabled>Apply…</option>
                  {presets.length === 0 && <option value="" disabled>(none saved yet)</option>}
                  {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                {presets.length > 0 && (
                  <div className="flex items-center gap-1 flex-wrap">
                    {presets.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => deletePreset(p.id)}
                        className="text-[10px] text-slate-400 hover:text-red-500 inline-flex items-center gap-0.5"
                        title={`Delete preset "${p.name}"`}
                      >
                        <Trash2 className="w-2.5 h-2.5" />
                        {p.name}
                      </button>
                    ))}
                  </div>
                )}
                {!showSavePreset ? (
                  <button
                    onClick={() => setShowSavePreset(true)}
                    className="ml-auto inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 underline-offset-2 hover:underline"
                  >
                    <BookmarkPlus className="w-3.5 h-3.5" />
                    Save current as preset
                  </button>
                ) : (
                  <div className="ml-auto flex items-center gap-1.5">
                    <input
                      autoFocus
                      type="text"
                      placeholder="Preset name"
                      value={presetName}
                      onChange={(e) => setPresetName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") void savePreset(); else if (e.key === "Escape") { setShowSavePreset(false); setPresetName(""); } }}
                      className="text-xs border border-slate-200 rounded-md px-2 py-1 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 w-40"
                    />
                    <button
                      onClick={savePreset}
                      disabled={savingPreset || !presetName.trim()}
                      className="text-xs px-2 py-1 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-slate-300"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => { setShowSavePreset(false); setPresetName(""); }}
                      className="text-xs text-slate-500 hover:text-slate-700"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>

              <ScoringWeightsEditor
                key={editorKey}
                initialWeights={data.weights}
                defaultWeights={data.orgDefaults}
                saveUrl={`/api/jobs/${jobId}/scoring`}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
