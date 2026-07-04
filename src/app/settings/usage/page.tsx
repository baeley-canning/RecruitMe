"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, Sparkles, TrendingUp } from "lucide-react";

interface Summary {
  orgId: string | null;
  windowDays: number;
  totalCostUsd: number;
  totalAiCalls: number;
  last24hCostUsd: number;
  last24hAiCalls: number;
  dailyCapUsd: number;
  capUsedFraction: number;
  daily: { date: string; costUsd: number; aiCalls: number }[];
  byType: { type: string; count: number; costUsd: number }[];
}

const TYPE_LABEL: Record<string, string> = {
  ai_call: "AI calls (billed)",
  score: "Scoring",
  score_all: "Re-score all",
  search: "Talent search",
  capture: "Profile capture",
  parse: "JD parsing",
  insight_extract: "Insight extraction",
  ai_error: "AI errors",
};

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

export default function UsagePage() {
  const [data, setData] = useState<Summary | null>(null);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/settings/usage?days=${days}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  const maxDay = data ? Math.max(0.01, ...data.daily.map((d) => d.costUsd)) : 0.01;
  const capPct = data ? Math.min(100, Math.round(data.capUsedFraction * 100)) : 0;
  const overCap = data ? data.capUsedFraction >= 1 : false;

  return (
    <div className="min-h-screen bg-surface-base">
      <div className="max-w-2xl mx-auto px-4 py-8">
        <Link href="/settings" className="inline-flex items-center gap-1.5 text-md text-text-tertiary hover:text-text-primary transition-colors mb-6">
          <ArrowLeft className="w-3.5 h-3.5" /> Settings
        </Link>

        <div className="flex items-center justify-between mb-1">
          <h1 className="text-md font-semibold text-text-primary">Usage &amp; AI cost</h1>
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="h-7 px-2 rounded bg-surface-sunken border border-separator text-xs text-text-secondary focus:outline-none focus:border-accent"
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </div>
        <p className="text-xs text-text-tertiary mb-6">
          What your organisation has spent on AI. Scoring runs on the free deterministic Fit score by default;
          these costs come from the AI actions you explicitly run (Score / Re-score, JD parsing, capture enrichment).
        </p>

        {loading || !data ? (
          <div className="flex items-center gap-2 text-text-secondary text-md py-12 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading usage…
          </div>
        ) : (
          <div className="space-y-4">
            {/* Headline cards */}
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-surface-raised border border-separator rounded-md p-4">
                <div className="flex items-center gap-1.5 text-2xs text-text-tertiary uppercase tracking-wide mb-1">
                  <Sparkles className="w-3 h-3" /> Spend · {data.windowDays}d
                </div>
                <div className="text-lg font-semibold text-text-primary data-mono">{usd(data.totalCostUsd)}</div>
                <div className="text-2xs text-text-tertiary mt-0.5">{data.totalAiCalls.toLocaleString()} billed AI calls</div>
              </div>
              <div className="bg-surface-raised border border-separator rounded-md p-4">
                <div className="flex items-center gap-1.5 text-2xs text-text-tertiary uppercase tracking-wide mb-1">
                  <TrendingUp className="w-3 h-3" /> Today (rolling 24h)
                </div>
                <div className="text-lg font-semibold text-text-primary data-mono">{usd(data.last24hCostUsd)}</div>
                <div className="text-2xs text-text-tertiary mt-0.5">{data.last24hAiCalls.toLocaleString()} calls</div>
              </div>
            </div>

            {/* Daily cap meter */}
            {data.dailyCapUsd > 0 && (
              <div className="bg-surface-raised border border-separator rounded-md p-4">
                <div className="flex items-center justify-between text-xs mb-2">
                  <span className="text-text-secondary">Daily spend cap</span>
                  <span className="data-mono text-text-tertiary">{usd(data.last24hCostUsd)} / {usd(data.dailyCapUsd)}</span>
                </div>
                <div className="h-2 rounded-full bg-surface-sunken overflow-hidden">
                  <div
                    className={`h-full rounded-full ${overCap ? "bg-danger" : capPct > 80 ? "bg-warning" : "bg-accent"}`}
                    style={{ width: `${capPct}%` }}
                  />
                </div>
                <p className="text-2xs text-text-tertiary mt-2">
                  {overCap
                    ? "The cap is reached — AI actions pause until the rolling window clears. Adjust AI_DAILY_SPEND_CAP_USD to change it."
                    : "AI actions are blocked once the rolling 24h spend reaches the cap, protecting you from a runaway bill."}
                </p>
              </div>
            )}

            {/* Daily spend sparkline */}
            <div className="bg-surface-raised border border-separator rounded-md p-4">
              <div className="text-xs text-text-secondary mb-3">Daily AI spend</div>
              {data.daily.every((d) => d.costUsd === 0) ? (
                <p className="text-xs text-text-tertiary py-6 text-center">No AI spend in this window.</p>
              ) : (
                <div className="flex items-end gap-0.5 h-24">
                  {data.daily.map((d) => (
                    <div
                      key={d.date}
                      className="flex-1 bg-accent/70 hover:bg-accent rounded-sm transition-colors min-h-[2px]"
                      style={{ height: `${Math.max(2, (d.costUsd / maxDay) * 100)}%` }}
                      title={`${d.date}: ${usd(d.costUsd)} · ${d.aiCalls} calls`}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* By type */}
            <div className="bg-surface-raised border border-separator rounded-md overflow-hidden">
              <div className="px-4 py-2.5 border-b border-separator text-xs text-text-secondary">Activity by type</div>
              {data.byType.length === 0 ? (
                <p className="text-xs text-text-tertiary py-6 text-center">No activity yet.</p>
              ) : (
                <table className="w-full">
                  <tbody>
                    {data.byType.map((t) => (
                      <tr key={t.type} className="border-b border-separator-subtle last:border-0">
                        <td className="px-4 py-2 text-base text-text-primary">{TYPE_LABEL[t.type] ?? t.type}</td>
                        <td className="px-4 py-2 text-base text-text-secondary data-mono text-right">{t.count.toLocaleString()}</td>
                        <td className="px-4 py-2 text-base text-text-secondary data-mono text-right w-20">{t.costUsd > 0 ? usd(t.costUsd) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
