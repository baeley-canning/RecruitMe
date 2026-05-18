"use client";

import { useEffect, useState } from "react";
import { showToast } from "@/components/ui/toast";

interface SubscriptionState {
  planName: string;
  status: string;
  seats: number;
  candidateLimit: number;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  isActive: boolean;
  limits: {
    hasArchetypeEngine: boolean;
    hasEmailDelivery: boolean;
    hasApiAccess: boolean;
    hasWhiteLabel: boolean;
  };
}

const PLAN_LABELS: Record<string, string> = {
  starter: "Starter",
  growth:  "Growth",
  agency:  "Agency",
};

const PLAN_PRICES: Record<string, string> = {
  starter: "$149/mo",
  growth:  "$399/mo",
  agency:  "$999/mo",
};

function PlanBadge({ plan, current }: { plan: string; current: boolean }) {
  const colours = current
    ? "bg-accent text-white"
    : "bg-neutral-100 text-neutral-600";
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${colours}`}>
      {current ? "Current plan" : PLAN_PRICES[plan]}
    </span>
  );
}

export default function BillingPage() {
  const [subscription, setSubscription] = useState<SubscriptionState | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/billing/subscription")
      .then((r) => r.json())
      .then(setSubscription)
      .catch(() => showToast("Failed to load subscription", "error"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="p-8 text-sm text-muted-foreground">Loading billing…</div>
    );
  }

  if (!subscription) {
    return (
      <div className="p-8 text-sm text-danger">Failed to load billing information.</div>
    );
  }

  const planLabel = PLAN_LABELS[subscription.planName] ?? subscription.planName;
  const periodEnd = subscription.currentPeriodEnd
    ? new Date(subscription.currentPeriodEnd).toLocaleDateString("en-NZ", { day: "numeric", month: "long", year: "numeric" })
    : null;
  const trialEnd = subscription.trialEndsAt
    ? new Date(subscription.trialEndsAt).toLocaleDateString("en-NZ", { day: "numeric", month: "long", year: "numeric" })
    : null;

  const plans = [
    {
      id: "starter",
      name: "Starter",
      price: "$149",
      description: "2 seats · 500 candidates · Core scoring",
      features: ["AI candidate scoring", "Job parsing", "Candidate library", "Shortlist reports"],
    },
    {
      id: "growth",
      name: "Growth",
      price: "$399",
      description: "10 seats · Unlimited candidates · Archetype Engine",
      features: ["Everything in Starter", "Archetype Engine", "Email delivery (Resend)", "Anti-archetype warnings", "Placement tracking"],
    },
    {
      id: "agency",
      name: "Agency",
      price: "$999",
      description: "Unlimited seats · Multi-branch · API access",
      features: ["Everything in Growth", "Unlimited seats", "API access", "White-label branding", "Priority support"],
    },
  ];

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-8">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Billing & Subscription</h1>
        <p className="text-sm text-muted-foreground mt-1">Manage your RecruitMe plan.</p>
      </div>

      {/* Current plan summary */}
      <div className="border border-border rounded-lg p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-semibold text-foreground">{planLabel} plan</div>
            <div className="text-sm text-muted-foreground mt-0.5">
              {subscription.seats === 0 ? "Unlimited" : subscription.seats} seat{subscription.seats !== 1 ? "s" : ""} ·{" "}
              {subscription.candidateLimit === 0 ? "Unlimited" : subscription.candidateLimit} candidates
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
              subscription.status === "active" || subscription.status === "trialing"
                ? "bg-success-subtle text-success"
                : "bg-warning-subtle text-warning"
            }`}>
              {subscription.status === "trialing" ? "Trial" : subscription.status.replace(/_/g, " ")}
            </span>
          </div>
        </div>

        {trialEnd && (
          <p className="text-sm text-warning">Trial ends {trialEnd}</p>
        )}
        {periodEnd && !trialEnd && (
          <p className="text-sm text-muted-foreground">
            {subscription.cancelAtPeriodEnd ? `Cancels on ${periodEnd}` : `Renews ${periodEnd}`}
          </p>
        )}

        <div className="pt-2 space-y-1">
          {[
            ["Archetype Engine", subscription.limits.hasArchetypeEngine],
            ["Email delivery", subscription.limits.hasEmailDelivery],
            ["API access", subscription.limits.hasApiAccess],
            ["White-label", subscription.limits.hasWhiteLabel],
          ].map(([label, enabled]) => (
            <div key={label as string} className="flex items-center gap-2 text-sm">
              <span className={enabled ? "text-success" : "text-muted-foreground"}>
                {enabled ? "✓" : "–"}
              </span>
              <span className={enabled ? "text-foreground" : "text-muted-foreground"}>{label as string}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Plan comparison */}
      <div>
        <h2 className="text-sm font-semibold text-foreground mb-3">Plans</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          {plans.map((plan) => {
            const isCurrent = subscription.planName === plan.id;
            return (
              <div
                key={plan.id}
                className={`border rounded-lg p-4 space-y-3 ${
                  isCurrent ? "border-accent bg-accent/5" : "border-border"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-semibold text-foreground">{plan.name}</div>
                    <div className="text-lg font-bold text-foreground mt-0.5">{plan.price}<span className="text-sm font-normal text-muted-foreground">/mo</span></div>
                  </div>
                  <PlanBadge plan={plan.id} current={isCurrent} />
                </div>
                <p className="text-xs text-muted-foreground">{plan.description}</p>
                <ul className="space-y-1">
                  {plan.features.map((f) => (
                    <li key={f} className="text-xs text-foreground flex gap-1.5">
                      <span className="text-success">✓</span>
                      {f}
                    </li>
                  ))}
                </ul>
                {!isCurrent && (
                  <a
                    href="/contact"
                    className="block text-center text-xs font-medium text-accent border border-accent rounded px-3 py-1.5 hover:bg-accent/10 transition-colors"
                  >
                    Contact us to upgrade
                  </a>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        To upgrade, downgrade, or cancel your subscription, contact support. Stripe self-service checkout coming soon.
      </p>
    </div>
  );
}
