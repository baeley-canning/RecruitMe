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
    <div className="mb-6 rounded-md border border-separator bg-surface-raised overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-surface-hover transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          <Sliders className="w-3.5 h-3.5 text-text-tertiary" />
          <span className="text-md font-semibold text-text-primary">Scoring weights for this job</span>
          {data?.hasOverride && (
            <span className="text-2xs uppercase tracking-wide font-semibold bg-accent-subtle text-accent rounded-sm px-1.5 py-0.5">
              Custom
            </span>
          )}
        </div>
        {open ? <ChevronUp className="w-3.5 h-3.5 text-text-tertiary" /> : <ChevronDown className="w-3.5 h-3.5 text-text-tertiary" />}
      </button>

      {open && (
        <div className="border-t border-separator p-4">
          {!loaded && <p className="text-xs text-text-tertiary">Loading…</p>}
          {loaded && data && (
            <>
              <p className="text-base text-text-secondary mb-4">
                Override scoring weights just for this job. Reset returns to your org-level defaults.
              </p>

              {/* Preset bar — apply a saved preset, or save the current weights as one */}
              <div className="mb-4 flex items-center gap-2 flex-wrap p-3 rounded bg-surface-sunken border border-separator">
                <span className="text-xs font-medium text-text-secondary">Preset:</span>
                <select
                  onChange={(e) => { if (e.target.value) void applyPreset(e.target.value); }}
                  defaultValue=""
                  className="h-6 px-2 rounded bg-surface-sunken border border-separator text-xs text-text-primary focus:outline-none focus:border-accent focus:shadow-focus"
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
                        className="text-2xs text-text-tertiary hover:text-danger inline-flex items-center gap-0.5"
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
                    className="ml-auto inline-flex items-center gap-1 text-xs text-accent hover:text-accent-hover underline-offset-2 hover:underline"
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
                      className="h-6 px-2 rounded bg-surface-sunken border border-separator text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus w-40"
                    />
                    <button
                      onClick={savePreset}
                      disabled={savingPreset || !presetName.trim()}
                      className="h-6 px-2 rounded text-xs bg-accent hover:bg-accent-hover text-white disabled:opacity-50"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => { setShowSavePreset(false); setPresetName(""); }}
                      className="text-xs text-text-secondary hover:text-text-primary"
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
