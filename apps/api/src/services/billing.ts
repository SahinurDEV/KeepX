import type { EntitlementDto } from "@vela/shared";
import { verifyStripeSignature } from "../billing.js";
import { HttpError } from "../http.js";
import { User } from "../models.js";

export function entitlementsFor(plan: "personal" | "plus", billing: boolean): EntitlementDto {
  return {
    plan,
    billing,
    features: { tasks: true, sharing: true, emailReminders: true, pushReminders: true },
  };
}

export async function accountPlan(userId: string): Promise<"personal" | "plus"> {
  const user = await User.findById(userId);
  if (!user) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
  return user.plan === "plus" ? "plus" : "personal";
}

export async function applyBillingEvent(payload: Buffer, header: string, secret: string): Promise<void> {
  if (!verifyStripeSignature(payload, header, secret)) {
    throw new HttpError(400, "INVALID_SIGNATURE", "The billing notice could not be verified.");
  }
  let event: { type?: string; data?: { object?: Record<string, unknown> } };
  try {
    event = JSON.parse(payload.toString("utf8")) as { type?: string; data?: { object?: Record<string, unknown> } };
  } catch {
    throw new HttpError(400, "INVALID_SIGNATURE", "The billing notice could not be verified.");
  }
  const object = event.data?.object;
  if (event.type === "checkout.session.completed") {
    if (object?.payment_status !== "paid") return;
    const userId = typeof object.client_reference_id === "string" ? object.client_reference_id : "";
    if (!/^[a-f\d]{24}$/i.test(userId)) return;
    const update: { plan: "plus"; stripeCustomerId?: string; stripeSubscriptionId?: string } = { plan: "plus" };
    if (typeof object.customer === "string" && /^cus_[A-Za-z0-9]+$/.test(object.customer)) update.stripeCustomerId = object.customer;
    if (typeof object.subscription === "string" && /^sub_[A-Za-z0-9]+$/.test(object.subscription)) {
      update.stripeSubscriptionId = object.subscription;
    }
    const user = await User.findByIdAndUpdate(userId, { $set: update });
    if (!user) console.error(JSON.stringify({ level: "error", event: "billing_account_missing" }));
    return;
  }
  if (event.type === "customer.subscription.deleted" && typeof object?.id === "string") {
    await User.updateOne({ stripeSubscriptionId: object.id }, { $set: { plan: "personal", stripeSubscriptionId: null } });
  }
}
