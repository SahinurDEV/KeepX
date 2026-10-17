import { createHmac, timingSafeEqual } from "node:crypto";
import type { StripeConfig } from "./config.js";

const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

export interface CheckoutRequest {
  userId: string;
  email: string;
  successUrl: string;
  cancelUrl: string;
}

export interface BillingClient {
  createCheckout(input: CheckoutRequest): Promise<string>;
}

export interface Billing {
  client: BillingClient;
  webhookSecret: string;
}

export function assertCheckoutUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "checkout.stripe.com") {
    throw new Error("Stripe checkout was rejected.");
  }
  return url;
}

export function verifyStripeSignature(payload: Buffer, header: string, secret: string, now = Date.now()): boolean {
  const parts = header.split(",").map((part) => {
    const index = part.indexOf("=");
    return index === -1 ? ["", ""] : [part.slice(0, index), part.slice(index + 1)];
  });
  const timestamp = parts.find((part) => part[0] === "t")?.[1] ?? "";
  const signatures = parts.filter((part) => part[0] === "v1" && part[1]).map((part) => part[1] ?? "");
  const seconds = Number(timestamp);
  if (!timestamp || !Number.isInteger(seconds) || signatures.length === 0) return false;
  if (Math.abs(now - seconds * 1000) > SIGNATURE_WINDOW_MS) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${payload.toString("utf8")}`).digest("hex");
  const expectedBuffer = Buffer.from(expected);
  return signatures.some((signature) => {
    const actual = Buffer.from(signature);
    return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
  });
}

export function createBilling(config: { stripe: StripeConfig | null }): Billing | null {
  if (!config.stripe) return null;
  const stripe = config.stripe;
  return {
    webhookSecret: stripe.webhookSecret,
    client: {
      async createCheckout(input) {
        const body = new URLSearchParams({
          mode: "subscription",
          "line_items[0][price]": stripe.priceId,
          "line_items[0][quantity]": "1",
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          client_reference_id: input.userId,
          customer_email: input.email,
          "metadata[userId]": input.userId,
        });
        const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
          method: "POST",
          headers: {
            authorization: `Bearer ${stripe.secretKey}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        const payload = (await response.json().catch(() => null)) as { url?: unknown } | null;
        if (!response.ok || typeof payload?.url !== "string") throw new Error("Stripe checkout was rejected.");
        return assertCheckoutUrl(payload.url);
      },
    },
  };
}
