/**
 * Stripe webhook handler.
 * Verifies Stripe signature using HMAC-SHA256, then updates the Subscription row.
 * Does NOT depend on the stripe npm package — raw webhook verification only.
 *
 * Supported events:
 *   customer.subscription.created
 *   customer.subscription.updated
 *   customer.subscription.deleted
 *   checkout.session.completed
 *
 * Set STRIPE_WEBHOOK_SECRET from the Stripe dashboard Webhook endpoint.
 */

import { NextResponse } from "next/server";
import { createHmac } from "crypto";
import { applyStripeWebhookUpdate } from "@/lib/subscriptions";
import { prisma } from "@/lib/db";

function planFromPriceId(priceId: string | undefined): string {
  if (!priceId) return "starter";
  if (priceId === process.env.STRIPE_PRICE_GROWTH) return "growth";
  if (priceId === process.env.STRIPE_PRICE_AGENCY) return "agency";
  return "starter";
}

function seatsForPlan(planName: string): number {
  if (planName === "growth") return 10;
  if (planName === "agency") return 999;
  return 2;
}

function candidateLimitForPlan(planName: string): number {
  if (planName === "growth" || planName === "agency") return 0;
  return 500;
}

function verifyStripeSignature(body: string, signature: string, secret: string): boolean {
  const parts = Object.fromEntries(
    signature.split(",").map((part) => {
      const [k, v] = part.split("=");
      return [k, v];
    })
  );
  const timestamp = parts["t"];
  const v1 = parts["v1"];
  if (!timestamp || !v1) return false;

  const payload = `${timestamp}.${body}`;
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  // Constant-time comparison
  if (expected.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  }
  return diff === 0;
}

export async function POST(req: Request) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return NextResponse.json({ error: "Stripe webhook not configured" }, { status: 503 });
  }

  const body      = await req.text();
  const signature = req.headers.get("stripe-signature") ?? "";

  if (!verifyStripeSignature(body, signature, webhookSecret)) {
    console.error("[stripe-webhook] signature verification failed");
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  let event: { type: string; data: { object: Record<string, unknown> } };
  try {
    event = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object;
        const items = sub["items"] as { data: Array<{ price: { id: string } }> } | undefined;
        const priceId  = items?.data[0]?.price?.id;
        const planName = planFromPriceId(priceId);

        await applyStripeWebhookUpdate(sub["customer"] as string, {
          stripeSubscriptionId: sub["id"] as string,
          stripePriceId: priceId,
          planName,
          status: sub["status"] as string,
          seats: seatsForPlan(planName),
          candidateLimit: candidateLimitForPlan(planName),
          currentPeriodEnd: new Date((sub["current_period_end"] as number) * 1000),
          cancelAtPeriodEnd: sub["cancel_at_period_end"] as boolean,
        });
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object;
        await applyStripeWebhookUpdate(sub["customer"] as string, {
          status: "canceled",
          cancelAtPeriodEnd: false,
        });
        break;
      }

      case "checkout.session.completed": {
        const session = event.data.object;
        const orgId    = session["client_reference_id"] as string | null;
        const customer = session["customer"] as string | null;
        if (orgId && customer) {
          await prisma.subscription.upsert({
            where: { orgId },
            create: {
              orgId,
              stripeCustomerId: customer,
              planName: "starter",
              status: "active",
              seats: 2,
              candidateLimit: 500,
            },
            update: { stripeCustomerId: customer },
          });
        }
        break;
      }
    }
  } catch (err) {
    console.error("[stripe-webhook] processing error:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Processing error" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
