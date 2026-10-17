import { Router } from "express";
import type { Billing } from "../billing.js";
import type { Config } from "../config.js";
import { HttpError, asyncRoute } from "../http.js";
import { requireUser, userId } from "../middleware/auth.js";
import { currentUser } from "../services/auth.js";
import { accountPlan, applyBillingEvent, entitlementsFor } from "../services/billing.js";

const UNCONFIGURED = "Billing is not connected. No payment is collected.";

export function billingRouter(config: Config, billing: Billing | null): Router {
  const router = Router();

  router.get(
    "/billing",
    requireUser(config),
    asyncRoute(async (req, res) => {
      res.json(entitlementsFor(await accountPlan(userId(req)), billing !== null));
    }),
  );

  router.post(
    "/billing/checkout",
    requireUser(config),
    asyncRoute(async (req, res) => {
      if (!billing) throw new HttpError(503, "BILLING_NOT_CONFIGURED", UNCONFIGURED);
      const user = await currentUser(userId(req));
      try {
        const url = await billing.client.createCheckout({
          userId: user.id,
          email: user.email,
          successUrl: `${config.appOrigin}/settings?billing=return`,
          cancelUrl: `${config.appOrigin}/pricing`,
        });
        res.json({ url });
      } catch {
        console.error(JSON.stringify({ level: "error", event: "billing_checkout_failed" }));
        throw new HttpError(502, "BILLING_FAILED", "Checkout could not be started.");
      }
    }),
  );

  router.post(
    "/billing/webhook",
    asyncRoute(async (req, res) => {
      if (!billing) throw new HttpError(503, "BILLING_NOT_CONFIGURED", UNCONFIGURED);
      const payload = (req as typeof req & { rawBody?: Buffer }).rawBody;
      if (!payload) throw new HttpError(400, "INVALID_SIGNATURE", "The billing notice could not be verified.");
      await applyBillingEvent(payload, req.get("stripe-signature") ?? "", billing.webhookSecret);
      res.status(204).end();
    }),
  );

  return router;
}
