import { NextResponse } from "next/server";
import { getAuth, unauthorized } from "@/lib/session";
import { getOrCreateSubscription } from "@/lib/subscriptions";

export async function GET() {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  if (!auth.orgId) {
    return NextResponse.json({ error: "No organisation" }, { status: 400 });
  }

  const subscription = await getOrCreateSubscription(auth.orgId);
  return NextResponse.json(subscription);
}
