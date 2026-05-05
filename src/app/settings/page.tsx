import { redirect } from "next/navigation";
import { getAuth } from "@/lib/session";
import { getOrgScoringWeights, DEFAULT_SCORING_WEIGHTS } from "@/lib/scoring-config";
import { ScoringWeightsEditor } from "@/components/scoring-weights-editor";
import { SlidersHorizontal } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const auth = await getAuth();
  if (!auth) redirect("/login");

  const weights = await getOrgScoringWeights(auth.orgId);

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-1">
          <div className="w-9 h-9 bg-indigo-50 rounded-lg flex items-center justify-center">
            <SlidersHorizontal className="w-5 h-5 text-indigo-600" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900">Scoring Settings</h1>
        </div>
        <p className="text-slate-500 text-sm ml-12">
          Control how the seven scoring dimensions are weighted when calculating a candidate's overall match score.
        </p>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-6">
        <ScoringWeightsEditor
          initialWeights={weights}
          defaultWeights={DEFAULT_SCORING_WEIGHTS}
        />
      </div>

      <div className="mt-6 bg-slate-50 rounded-xl border border-slate-200 p-5">
        <h2 className="text-sm font-semibold text-slate-700 mb-3">How the score is calculated</h2>
        <div className="grid grid-cols-2 gap-3 text-xs text-slate-600">
          <div>
            <p className="font-medium text-slate-700">Must-have coverage (default 36%)</p>
            <p>The primary gate. If key requirements are confirmed absent on a full profile, the score is capped at 50% regardless of other dimensions.</p>
          </div>
          <div>
            <p className="font-medium text-slate-700">Skill fit (default 22%)</p>
            <p>Technical and role-specific alignment across the candidate's full profile — harder to fake than title or domain.</p>
          </div>
          <div>
            <p className="font-medium text-slate-700">Domain fit (default 10%)</p>
            <p>Sector experience and vocabulary alignment. A banking engineer scores higher for a banking role than a general engineer.</p>
          </div>
          <div>
            <p className="font-medium text-slate-700">Seniority fit (default 10%)</p>
            <p>Career level relative to the role's expectation. Over- and under-seniority both reduce this score.</p>
          </div>
          <div>
            <p className="font-medium text-slate-700">Location fit (default 8%)</p>
            <p>Geographic proximity. Kept intentionally low so a strong Wellington candidate isn't penalised for a slightly different suburb listing.</p>
          </div>
          <div>
            <p className="font-medium text-slate-700">Title fit (default 8%)</p>
            <p>How closely past job titles match the target role family. Useful signal but easy to game with keyword stuffing.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
