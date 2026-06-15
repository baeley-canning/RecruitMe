import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Tags } from "lucide-react";
import { getAuth } from "@/lib/session";
import { isRemindersEnabled } from "@/lib/feature-flags";
import { TagManager } from "@/components/settings/tag-manager";

export const dynamic = "force-dynamic";

export default async function TagsSettingsPage() {
  const auth = await getAuth();
  if (!auth) redirect("/login");
  if (!isRemindersEnabled()) notFound();

  return (
    <div>
      <div className="toolbar">
        <Link href="/settings" className="inline-flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors">
          <ArrowLeft className="w-3.5 h-3.5" />
          Settings
        </Link>
        <div className="w-px h-4 bg-separator mx-1" />
        <Tags className="w-3.5 h-3.5 text-text-secondary" />
        <h1 className="text-md font-semibold text-text-primary">Candidate Tags</h1>
      </div>

      <div className="p-4 max-w-2xl mx-auto">
        <p className="text-base text-text-secondary mb-4">
          Tags help you group candidates across jobs (e.g. &ldquo;Hot&rdquo;, &ldquo;Passive&rdquo;, &ldquo;Do not contact&rdquo;).
          Manage them here; assign them from a candidate&apos;s card.
        </p>
        <TagManager />
      </div>
    </div>
  );
}
