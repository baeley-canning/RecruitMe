import { redirect } from "next/navigation";
import Link from "next/link";
import { getAuth } from "@/lib/session";
import { getOrgScoringWeights, DEFAULT_SCORING_WEIGHTS } from "@/lib/scoring-config";
import { ScoringWeightsEditor } from "@/components/scoring-weights-editor";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { SlidersHorizontal, ArrowLeft, Brain, ChevronRight, Palette, Tags } from "lucide-react";
import { isWhiteLabelEnabled, isRemindersEnabled } from "@/lib/feature-flags";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const auth = await getAuth();
  if (!auth) redirect("/login");

  const weights = await getOrgScoringWeights(auth.orgId);

  return (
    <div>
      {/* Toolbar */}
      <div className="toolbar">
        <Link
          href="/jobs"
          className="inline-flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back
        </Link>
        <div className="w-px h-4 bg-separator mx-1" />
        <SlidersHorizontal className="w-3.5 h-3.5 text-text-secondary" />
        <h1 className="text-md font-semibold text-text-primary">Scoring Settings</h1>
      </div>

      <div className="p-4 max-w-5xl mx-auto space-y-4">
        <p className="text-base text-text-secondary">
          Control how the seven scoring dimensions are weighted when calculating a candidate&apos;s overall match score.
        </p>

        <Card>
          <CardBody>
            <ScoringWeightsEditor
              initialWeights={weights}
              defaultWeights={DEFAULT_SCORING_WEIGHTS}
            />
          </CardBody>
        </Card>

        <Link
          href="/settings/memory"
          className="flex items-center justify-between gap-4 px-4 py-3 bg-surface-raised rounded-md border border-separator hover:bg-surface-hover transition-colors group"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-7 h-7 bg-llama-subtle rounded flex items-center justify-center flex-shrink-0">
              <Brain className="w-3.5 h-3.5 text-llama" />
            </div>
            <div className="min-w-0">
              <p className="text-md font-medium text-text-primary">Recruiter memory</p>
              <p className="text-xs text-text-tertiary mt-0.5">
                View and remove past score corrections influencing future scoring
              </p>
            </div>
          </div>
          <ChevronRight className="w-3.5 h-3.5 text-text-tertiary group-hover:text-text-secondary flex-shrink-0" />
        </Link>

        {isRemindersEnabled() && (
          <Link
            href="/settings/tags"
            className="flex items-center justify-between gap-4 px-4 py-3 bg-surface-raised rounded-md border border-separator hover:bg-surface-hover transition-colors group"
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-7 h-7 bg-accent-subtle rounded flex items-center justify-center flex-shrink-0">
                <Tags className="w-3.5 h-3.5 text-accent" />
              </div>
              <div className="min-w-0">
                <p className="text-md font-medium text-text-primary">Candidate tags</p>
                <p className="text-xs text-text-tertiary mt-0.5">
                  Create, recolour, and remove the tags you organise candidates with
                </p>
              </div>
            </div>
            <ChevronRight className="w-3.5 h-3.5 text-text-tertiary group-hover:text-text-secondary flex-shrink-0" />
          </Link>
        )}

        {isWhiteLabelEnabled() && (
          <Link
            href="/settings/white-label"
            className="flex items-center justify-between gap-4 px-4 py-3 bg-surface-raised rounded-md border border-separator hover:bg-surface-hover transition-colors group"
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-7 h-7 bg-accent-subtle rounded flex items-center justify-center flex-shrink-0">
                <Palette className="w-3.5 h-3.5 text-accent" />
              </div>
              <div className="min-w-0">
                <p className="text-md font-medium text-text-primary">White-label branding</p>
                <p className="text-xs text-text-tertiary mt-0.5">
                  Custom logo, brand name, and accent colour across the app
                </p>
              </div>
            </div>
            <ChevronRight className="w-3.5 h-3.5 text-text-tertiary group-hover:text-text-secondary flex-shrink-0" />
          </Link>
        )}

        <Card>
          <CardHeader>
            <h2 className="text-md font-semibold text-text-primary">How the score is calculated</h2>
          </CardHeader>
          <CardBody className="grid grid-cols-2 gap-3 text-xs text-text-secondary">
            <div>
              <p className="font-medium text-text-primary">Must-have coverage (default 36%)</p>
              <p className="mt-0.5">
                The primary gate. If key requirements are confirmed absent on a full profile, the score is capped at 50% regardless of other dimensions.
              </p>
            </div>
            <div>
              <p className="font-medium text-text-primary">Skill fit (default 22%)</p>
              <p className="mt-0.5">
                Technical and role-specific alignment across the candidate&apos;s full profile — harder to fake than title or domain.
              </p>
            </div>
            <div>
              <p className="font-medium text-text-primary">Domain fit (default 10%)</p>
              <p className="mt-0.5">
                Sector experience and vocabulary alignment. A banking engineer scores higher for a banking role than a general engineer.
              </p>
            </div>
            <div>
              <p className="font-medium text-text-primary">Seniority fit (default 10%)</p>
              <p className="mt-0.5">
                Career level relative to the role&apos;s expectation. Over- and under-seniority both reduce this score.
              </p>
            </div>
            <div>
              <p className="font-medium text-text-primary">Location fit (default 8%)</p>
              <p className="mt-0.5">
                Geographic proximity. Kept intentionally low so a strong Wellington candidate isn&apos;t penalised for a slightly different suburb listing.
              </p>
            </div>
            <div>
              <p className="font-medium text-text-primary">Title fit (default 8%)</p>
              <p className="mt-0.5">
                How closely past job titles match the target role family. Useful signal but easy to game with keyword stuffing.
              </p>
            </div>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
