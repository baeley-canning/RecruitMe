/**
 * Subscription plan management — Stripe-backed, with local DB mirror.
 *
 * Plan tiers:
 *   starter  ($149/mo): 2 seats, 500 candidates, core scoring
 *   growth   ($399/mo): 10 seats, unlimited candidates, Archetype Engine, email
 *   agency   ($999/mo): unlimited seats, multi-branch, white-label, API access
 *
 * The DB Subscription row is the source of truth for enforcement. Stripe webhooks
 * update it; the API routes read it. This means the system works even if Stripe
 * is temporarily unreachable.
 */

import { prisma } from "./db";

export interface PlanLimits {
  seats: number;           // max concurrent user accounts
  candidateLimit: number;  // 0 = unlimited
  hasArchetypeEngine: boolean;
  hasEmailDelivery: boolean;
  hasApiAccess: boolean;
  hasWhiteLabel: boolean;
}

export const PLAN_LIMITS: Record<string, PlanLimits> = {
  starter: {
    seats: 2,
    candidateLimit: 500,
    hasArchetypeEngine: false,
    hasEmailDelivery: false,
    hasApiAccess: false,
    hasWhiteLabel: false,
  },
  growth: {
    seats: 10,
    candidateLimit: 0, // unlimited
    hasArchetypeEngine: true,
    hasEmailDelivery: true,
    hasApiAccess: false,
    hasWhiteLabel: false,
  },
  agency: {
    seats: 0, // unlimited
    candidateLimit: 0, // unlimited
    hasArchetypeEngine: true,
    hasEmailDelivery: true,
    hasApiAccess: true,
    hasWhiteLabel: true,
  },
};

export interface SubscriptionState {
  planName: string;
  status: string;
  seats: number;
  candidateLimit: number;
  currentPeriodEnd: Date | null;
  trialEndsAt: Date | null;
  cancelAtPeriodEnd: boolean;
  limits: PlanLimits;
  isActive: boolean;
}

/** Retrieve or create the subscription row for an org. Orgs default to starter plan. */
export async function getOrCreateSubscription(orgId: string): Promise<SubscriptionState> {
  let sub = await prisma.subscription.findUnique({ where: { orgId } });

  if (!sub) {
    sub = await prisma.subscription.create({
      data: {
        orgId,
        planName: "starter",
        status: "active",
        seats: 2,
        candidateLimit: 500,
      },
    });
  }

  const limits = PLAN_LIMITS[sub.planName] ?? PLAN_LIMITS.starter;
  const isActive = sub.status === "active" || sub.status === "trialing";

  return {
    planName: sub.planName,
    status: sub.status,
    seats: sub.seats,
    candidateLimit: sub.candidateLimit,
    currentPeriodEnd: sub.currentPeriodEnd,
    trialEndsAt: sub.trialEndsAt,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    limits,
    isActive,
  };
}

/** Check if an org can add more candidates. Returns { allowed, reason }. */
export async function checkCandidateLimit(orgId: string): Promise<{
  allowed: boolean;
  current: number;
  limit: number;
  reason?: string;
}> {
  const sub = await getOrCreateSubscription(orgId);
  if (sub.candidateLimit === 0 || !sub.isActive) {
    return { allowed: true, current: 0, limit: 0 };
  }

  const current = await prisma.candidate.count({
    where: {
      job: { orgId },
    },
  });

  if (current >= sub.candidateLimit) {
    return {
      allowed: false,
      current,
      limit: sub.candidateLimit,
      reason: `Candidate limit reached (${current}/${sub.candidateLimit}). Upgrade to Growth plan for unlimited candidates.`,
    };
  }

  return { allowed: true, current, limit: sub.candidateLimit };
}

/** Check if an org can add more seats. Returns { allowed, reason }. */
export async function checkSeatLimit(orgId: string): Promise<{
  allowed: boolean;
  current: number;
  limit: number;
  reason?: string;
}> {
  const sub = await getOrCreateSubscription(orgId);
  if (sub.seats === 0 || !sub.isActive) {
    return { allowed: true, current: 0, limit: 0 };
  }

  const current = await prisma.user.count({ where: { orgId } });

  if (current >= sub.seats) {
    return {
      allowed: false,
      current,
      limit: sub.seats,
      reason: `Seat limit reached (${current}/${sub.seats}). Upgrade your plan to add more users.`,
    };
  }

  return { allowed: true, current, limit: sub.seats };
}

/** Check if an org has access to a specific feature. */
export async function checkFeatureAccess(
  orgId: string,
  feature: keyof PlanLimits,
): Promise<{ allowed: boolean; reason?: string }> {
  const sub = await getOrCreateSubscription(orgId);
  if (!sub.isActive) {
    return { allowed: false, reason: "Subscription is not active." };
  }
  const allowed = sub.limits[feature] as boolean;
  if (!allowed) {
    return {
      allowed: false,
      reason: `Feature "${feature}" requires Growth plan or higher. Upgrade at /settings/billing.`,
    };
  }
  return { allowed: true };
}

/** Apply a Stripe webhook update to the subscription row. */
export async function applyStripeWebhookUpdate(
  stripeCustomerId: string,
  update: {
    stripeSubscriptionId?: string;
    stripePriceId?: string;
    planName?: string;
    status?: string;
    seats?: number;
    candidateLimit?: number;
    currentPeriodEnd?: Date | null;
    cancelAtPeriodEnd?: boolean;
  },
): Promise<void> {
  await prisma.subscription.updateMany({
    where: { stripeCustomerId },
    data: {
      ...(update.stripeSubscriptionId !== undefined && { stripeSubscriptionId: update.stripeSubscriptionId }),
      ...(update.stripePriceId !== undefined && { stripePriceId: update.stripePriceId }),
      ...(update.planName !== undefined && { planName: update.planName }),
      ...(update.status !== undefined && { status: update.status }),
      ...(update.seats !== undefined && { seats: update.seats }),
      ...(update.candidateLimit !== undefined && { candidateLimit: update.candidateLimit }),
      ...(update.currentPeriodEnd !== undefined && { currentPeriodEnd: update.currentPeriodEnd }),
      ...(update.cancelAtPeriodEnd !== undefined && { cancelAtPeriodEnd: update.cancelAtPeriodEnd }),
      updatedAt: new Date(),
    },
  });
}
