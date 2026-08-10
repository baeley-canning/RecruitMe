"use client";

import { useState, useCallback } from "react";
import { RotateCcw, Save, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ScoringWeights } from "@/lib/scoring-config";
import { WEIGHT_LABELS, WEIGHT_DESCRIPTIONS } from "@/lib/scoring-weights-labels";

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
          stroke={level === 1 ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.05)"}
          strokeWidth={level === 1 ? 1.5 : 1}
        />
      ))}
      {outerPts.map((pt, i) => (
        <line key={i} x1={CX} y1={CY} x2={pt.x} y2={pt.y} stroke="rgba(255,255,255,0.05)" strokeWidth={1} />
      ))}
      {/* Default weights ghost */}
      <polygon
        points={toPoints(defaultPts)}
        fill="rgba(161,161,166,0.08)"
        stroke="rgba(161,161,166,0.5)"
        strokeWidth={1}
        strokeDasharray="3,3"
      />
      {/* Current weights fill */}
      <polygon
        points={toPoints(weightPts)}
        fill="rgba(10,132,255,0.18)"
        stroke="#0a84ff"
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
            <text x={lp.x} y={lp.y - 5} textAnchor={anchor} fill="#a1a1a6" fontSize={8.5}
              fontFamily="ui-sans-serif,system-ui,sans-serif">
              {WEIGHT_LABELS[axis.key]}
            </text>
            <text x={lp.x} y={lp.y + 8} textAnchor={anchor} fill="#f5f5f7" fontSize={11}
              fontWeight="600" fontFamily="ui-sans-serif,system-ui,sans-serif">
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
      <div className="bg-surface-raised rounded-md border border-separator p-6 flex flex-col items-center">
        <p className="text-2xs font-semibold text-text-tertiary uppercase tracking-wider mb-1">
          Score weight distribution
        </p>
        <p className="text-xs text-text-tertiary mb-4">
          Dashed outline = defaults · Filled = current
        </p>
        <WeightsRadar weights={weights} defaultWeights={defaultWeights} />
        <div className="mt-4 flex items-center gap-4 text-xs text-text-tertiary">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-4 h-px border-t-2 border-dashed border-separator-strong" />
            Defaults
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-4 h-0.5 bg-accent rounded" />
            Current
          </span>
        </div>
      </div>

      {/* Sliders */}
      <div className="space-y-1">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-md font-semibold text-text-primary">Adjust weights</h3>
            <p className="text-xs text-text-secondary">Moving one slider auto-scales the others to maintain 100%</p>
          </div>
          <span className={cn(
            "text-xs font-mono px-2 py-0.5 rounded-sm data-mono",
            Math.abs(total - 1) < 0.001 ? "text-success bg-success-subtle" : "text-danger bg-danger-subtle"
          )}>
            {Math.round(total * 100)}%
          </span>
        </div>

        {AXES.map(({ key, color }) => {
          const pct = Math.round(weights[key] * 100);
          const defPct = Math.round(defaultWeights[key] * 100);
          return (
            <div key={key} className="group p-3 rounded hover:bg-surface-hover transition-colors">
              <div className="flex items-center justify-between mb-1.5">
                <div>
                  <span className="text-md font-medium text-text-primary">{WEIGHT_LABELS[key]}</span>
                  <p className="text-xs text-text-tertiary mt-0.5">{WEIGHT_DESCRIPTIONS[key]}</p>
                </div>
                <div className="text-right ml-4 flex-shrink-0">
                  <span className="text-lg font-semibold tabular-nums data-mono" style={{ color }}>{pct}%</span>
                  {pct !== defPct && (
                    <p className="text-2xs text-text-tertiary data-mono">default: {defPct}%</p>
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
                  background: `linear-gradient(to right, ${color} 0%, ${color} ${pct / 60 * 100}%, #323234 ${pct / 60 * 100}%, #323234 100%)`
                }}
              />
            </div>
          );
        })}

        <div className="flex items-center gap-3 pt-4">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 h-7 px-3 bg-accent hover:bg-accent-hover disabled:opacity-50 text-text-inverse rounded text-md font-medium transition-colors"
          >
            {saved ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
            {saving ? "Saving…" : saved ? "Saved" : "Save weights"}
          </button>
          <button
            onClick={handleReset}
            className="flex items-center gap-2 h-7 px-3 border border-separator bg-surface-hover hover:bg-surface-overlay text-text-primary rounded text-md font-medium transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset to defaults
          </button>
          {error && <p className="text-xs text-danger">{error}</p>}
        </div>

        <div className="mt-4 p-3 bg-warning-subtle border border-separator rounded-md">
          <p className="text-xs text-warning font-medium mb-1">Changes take effect on next re-score</p>
          <p className="text-xs text-text-secondary">
            Existing candidate scores reflect the weights that were active when they were last scored.
            Run &quot;Re-score all&quot; after saving to apply the new weights.
          </p>
        </div>
      </div>
    </div>
  );
}
