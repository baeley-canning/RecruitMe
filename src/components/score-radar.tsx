"use client";

export interface RadarDimensions {
  skills: number;
  title: number;
  industry: number;
  location: number;
  seniority: number;
}

const AXES: { key: keyof RadarDimensions; label: string }[] = [
  { key: "skills",     label: "Skills"      },
  { key: "title",      label: "Title"       },
  { key: "industry",   label: "Industry"    },
  { key: "location",   label: "Location"    },
  { key: "seniority",  label: "Seniority"   },
];

const CX = 120;
const CY = 115;
const R  = 72;  // outer polygon radius
const LR = 100; // label radius

// Pro App palette equivalents — kept as raw rgba so they can sit on inline
// SVG attributes that don't accept Tailwind classes. Values mirror tokens in
// tailwind.config.ts (separator strong/default, accent blue).
const STROKE_GRID_STRONG = "rgba(255, 255, 255, 0.12)"; // separator-strong
const STROKE_GRID        = "rgba(255, 255, 255, 0.08)"; // separator
const ACCENT             = "#0a84ff";                    // accent
const ACCENT_FILL        = "rgba(10, 132, 255, 0.20)";   // accent/20

function polar(cx: number, cy: number, r: number, i: number, n: number) {
  const angle = (2 * Math.PI * i) / n - Math.PI / 2;
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
}

function toPoints(pts: { x: number; y: number }[]) {
  return pts.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
}

export function ScoreRadar({ dimensions }: { dimensions: RadarDimensions }) {
  const n = AXES.length;
  const outerPts = AXES.map((_, i) => polar(CX, CY, R, i, n));
  const scorePts = AXES.map((axis, i) => {
    const r = (Math.min(100, Math.max(0, dimensions[axis.key])) / 100) * R;
    return polar(CX, CY, r, i, n);
  });
  const labelPts = AXES.map((_, i) => polar(CX, CY, LR, i, n));

  const gridLevels = [0.25, 0.5, 0.75, 1];

  return (
    <div className="bg-surface-raised rounded-md border border-separator p-4 w-[260px]">
      <p className="text-2xs font-medium text-text-tertiary uppercase tracking-wider text-center mb-2">
        Match Breakdown
      </p>
      <svg viewBox="0 0 240 230" width="100%" className="overflow-visible">
        {/* Grid rings */}
        {gridLevels.map((level) => {
          const pts = AXES.map((_, i) => polar(CX, CY, R * level, i, n));
          return (
            <polygon
              key={level}
              points={toPoints(pts)}
              fill="none"
              stroke={level === 1 ? STROKE_GRID_STRONG : STROKE_GRID}
              strokeWidth={1}
            />
          );
        })}

        {/* Axis spokes */}
        {outerPts.map((pt, i) => (
          <line
            key={i}
            x1={CX} y1={CY}
            x2={pt.x} y2={pt.y}
            stroke={STROKE_GRID}
            strokeWidth={1}
          />
        ))}

        {/* Score fill */}
        <polygon
          points={toPoints(scorePts)}
          fill={ACCENT_FILL}
          stroke={ACCENT}
          strokeWidth={1.5}
          strokeLinejoin="round"
        />

        {/* Vertex dots */}
        {scorePts.map((pt, i) => (
          <circle key={i} cx={pt.x} cy={pt.y} r={2.5} fill={ACCENT} />
        ))}

        {/* Labels */}
        {AXES.map((axis, i) => {
          const lp = labelPts[i];
          const anchor =
            lp.x < CX - 6 ? "end" : lp.x > CX + 6 ? "start" : "middle";
          const val = dimensions[axis.key];
          return (
            <g key={i}>
              <text
                x={lp.x}
                y={lp.y - 5}
                textAnchor={anchor}
                className="fill-text-secondary"
                fontSize={10}
              >
                {axis.label}
              </text>
              <text
                x={lp.x}
                y={lp.y + 9}
                textAnchor={anchor}
                className="fill-text-primary"
                fontSize={11}
                fontFamily='"SF Mono", ui-monospace, Menlo, Monaco, Consolas, monospace'
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {val}%
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
