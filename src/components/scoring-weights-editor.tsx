"use client";

import { useState, useCallback } from "react";
import { RotateCcw, Save, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ScoringWeights } from "@/lib/scoring-config";
import { WEIGHT_LABELS, WEIGHT_DESCRIPTIONS } from "@/lib/scoring-config";

// ─── Radar chart ──────────────────────────────────────────────────────────────

const AXES: { key: keyof ScoringWeights; color: string }[] = [
  { key: "must_have",        color: "#6366f1" },
  { key: "skill_fit",        color: "#3b82f6" },
  { key: "seniority_fit",    color: "#0ea5e9" },
  { key: "domain_fit",       color: "#14b8a6" },
  { key: "location_fit",     color: "#22c55e" },
  { key: "title_fit",        color: "#eab308" },
  { key: "nice_to_have_fit", color: "#f97316" },
];

const CX = 140, CY = 130, R = 88, LR = 116;

function polar(cx: number, cy: number, r: number, i: number, n: number) {
  const angle = (2 * Math.PI * i) / n - Math.PI / 2;
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
}

function toPoints(pts: { x: number; y: number }[]) {
  return pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
}

function WeightsRadar({ weights, defaultWeights }: { weights: ScoringWeights; defaultWeights: ScoringWeights }) {
  const n = AXES.length;
  const outerPts = AXES.map((_, i) => polar(CX, CY, R, i, n));
  // Scale weights so max possible (0.5) fills the radar
  const scale = (v: number) => Math.min(1, v / 0.5);
  const weightPts = AXES.map((axis, i) => {
    const r = scale(weights[axis.key]) * R;
    return polar(CX, CY, r, i, n);
  });
  const defaultPts = AXES.map((axis, i) => {
    const r = scale(defaultWeights[axis.key]) * R;
    return polar(CX, CY, r, i, n);
  });
  const labelPts = AXES.map((_, i) => polar(CX, CY, LR, i, n));
  const gridLevels = [0.25, 0.5, 0.75, 1];

  return (
    <svg viewBox="0 0 280 260" className="w-full max-w-[320px] mx-auto overflow-visible">
      {gridLevels.map((level) => (
        <polygon
          key={level}
          points={toPoints(AXES.map((_, i) => polar(CX, CY, R * level, i, n)))}
          fill="none"
          stroke={level === 1 ? "#334155" : "#1e293b"}
          strokeWidth={level === 1 ? 1.5 : 1}
        />
      ))}
      {outerPts.map((pt, i) => (
        <line key={i} x1={CX} y1={CY} x2={pt.x} y2={pt.y} stroke="#1e293b" strokeWidth={1} />
      ))}
      {/* Default weights ghost */}
      <polygon
        points={toPoints(defaultPts)}
        fill="rgba(100,116,139,0.08)"
        stroke="#475569"
        strokeWidth={1}
        strokeDasharray="3,3"
      />
      {/* Current weights fill */}
      <polygon
        points={toPoints(weightPts)}
        fill="rgba(99,102,241,0.15)"
        stroke="#6366f1"
        strokeWidth={2}
        strokeLinejoin="round"
      />
      {weightPts.map((pt, i) => (
        <circle key={i} cx={pt.x} cy={pt.y} r={3.5} fill={AXES[i].color} />
      ))}
      {AXES.map((axis, i) => {
        const lp = labelPts[i];
        const anchor = lp.x < CX - 8 ? "end" : lp.x > CX + 8 ? "start" : "middle";
        const pct = Math.round(weights[axis.key] * 100);
        return (
          <g key={i}>
            <text x={lp.x} y={lp.y - 5} textAnchor={anchor} fill="#94a3b8" fontSize={8.5}
              fontFamily="ui-sans-serif,system-ui,sans-serif">
              {WEIGHT_LABELS[axis.key]}
            </text>
            <text x={lp.x} y={lp.y + 8} textAnchor={anchor} fill="#e2e8f0" fontSize={11}
              fontWeight="700" fontFamily="ui-sans-serif,system-ui,sans-serif">
              {pct}%
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ─── Main editor ──────────────────────────────────────────────────────────────

export function ScoringWeightsEditor({
  initialWeights,
  defaultWeights,
  saveUrl = "/api/settings/scoring",
}: {
  initialWeights: ScoringWeights;
  defaultWeights: ScoringWeights;
  /**
   * The endpoint that handles PUT/GET/DELETE for these weights. Defaults to the
   * org-level settings endpoint; pass `/api/jobs/[id]/scoring` for per-job overrides.
   * Endpoint contract: PUT body = ScoringWeights JSON; GET returns `{ weights }`;
   * DELETE clears the override (per-job) or resets to defaults (org).
   */
  saveUrl?: string;
}) {
  const [weights, setWeights] = useState<ScoringWeights>(initialWeights);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const total = Object.values(weights).reduce((s, v) => s + v, 0);

  const handleSlider = useCallback((key: keyof ScoringWeights, rawPct: number) => {
    const newVal = Math.max(0.01, Math.min(0.70, rawPct / 100));
    setWeights((prev) => {
      const other = Object.keys(prev).filter((k) => k !== key) as (keyof ScoringWeights)[];
      const remaining = Math.max(0, 1 - newVal);
      const otherTotal = other.reduce((s, k) => s + prev[k], 0);
      const scaled: Partial<ScoringWeights> = {};
      other.forEach((k) => {
        scaled[k] = otherTotal > 0 ? (prev[k] / otherTotal) * remaining : remaining / other.length;
      });
      return { ...prev, ...scaled, [key]: newVal } as ScoringWeights;
    });
    setSaved(false);
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(saveUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(weights),
      });
      if (!res.ok) throw new Error("Save failed");
      // Re-fetch to confirm what the server actually persisted — prevents
      // showing "Saved" when the DB write silently succeeded but stored wrong values.
      const verify = await fetch(saveUrl);
      if (verify.ok) {
        const { weights: confirmed } = await verify.json() as { weights: typeof weights };
        setWeights(confirmed);
      }
      setSaved(true);
    } catch {
      setError("Failed to save — please try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setWeights(defaultWeights);
    setSaved(false);
    setError(null);
    await fetch(saveUrl, { method: "DELETE" });
    setSaved(true);
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
      {/* Radar */}
      <div className="bg-slate-900 rounded-2xl border border-slate-700 p-6 flex flex-col items-center">
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
          Score weight distribution
        </p>
        <p className="text-[11px] text-slate-500 mb-4">
          Dashed outline = defaults · Filled = current
        </p>
        <WeightsRadar weights={weights} defaultWeights={defaultWeights} />
        <div className="mt-4 flex items-center gap-4 text-[11px] text-slate-400">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-4 h-px border-t-2 border-dashed border-slate-500" />
            Defaults
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-4 h-0.5 bg-indigo-400 rounded" />
            Current
          </span>
        </div>
      </div>

      {/* Sliders */}
      <div className="space-y-1">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Adjust weights</h3>
            <p className="text-xs text-slate-500">Moving one slider auto-scales the others to maintain 100%</p>
          </div>
          <span className={cn(
            "text-xs font-mono px-2 py-0.5 rounded",
            Math.abs(total - 1) < 0.001 ? "text-emerald-600 bg-emerald-50" : "text-red-600 bg-red-50"
          )}>
            {Math.round(total * 100)}%
          </span>
        </div>

        {AXES.map(({ key, color }) => {
          const pct = Math.round(weights[key] * 100);
          const defPct = Math.round(defaultWeights[key] * 100);
          return (
            <div key={key} className="group p-3 rounded-lg hover:bg-slate-50 transition-colors">
              <div className="flex items-center justify-between mb-1.5">
                <div>
                  <span className="text-sm font-medium text-slate-800">{WEIGHT_LABELS[key]}</span>
                  <p className="text-[11px] text-slate-400 mt-0.5">{WEIGHT_DESCRIPTIONS[key]}</p>
                </div>
                <div className="text-right ml-4 flex-shrink-0">
                  <span className="text-lg font-bold tabular-nums" style={{ color }}>{pct}%</span>
                  {pct !== defPct && (
                    <p className="text-[10px] text-slate-400">default: {defPct}%</p>
                  )}
                </div>
              </div>
              <input
                type="range"
                min={1}
                max={60}
                value={pct}
                onChange={(e) => handleSlider(key, Number(e.target.value))}
                className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
                style={{
                  background: `linear-gradient(to right, ${color} 0%, ${color} ${pct / 60 * 100}%, #e2e8f0 ${pct / 60 * 100}%, #e2e8f0 100%)`
                }}
              />
            </div>
          );
        })}

        <div className="flex items-center gap-3 pt-4">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
          >
            {saved ? <CheckCircle2 className="w-4 h-4" /> : <Save className="w-4 h-4" />}
            {saving ? "Saving…" : saved ? "Saved" : "Save weights"}
          </button>
          <button
            onClick={handleReset}
            className="flex items-center gap-2 px-4 py-2 border border-slate-200 hover:bg-slate-50 text-slate-600 rounded-lg text-sm font-medium transition-colors"
          >
            <RotateCcw className="w-4 h-4" />
            Reset to defaults
          </button>
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>

        <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
          <p className="text-xs text-amber-700 font-medium mb-1">Changes take effect on next re-score</p>
          <p className="text-[11px] text-amber-600">
            Existing candidate scores reflect the weights that were active when they were last scored.
            Run &quot;Re-score all&quot; after saving to apply the new weights.
          </p>
        </div>
      </div>
    </div>
  );
}
