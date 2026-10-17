import type { Metadata } from "next";
import { PRICING_PLANS } from "@vela/shared";
import { PlanAction } from "@/components/plan-action";
import { SiteFrame } from "@/components/site-frame";

export const metadata: Metadata = { title: "Pricing" };

export default function PricingPage() {
  return (
    <SiteFrame>
      <div className="mx-auto max-w-5xl px-5 py-16">
        <h1 className="font-serif text-5xl">Pricing</h1>
        <p className="mt-4 max-w-2xl text-muted">
          The personal workspace is free. Plus stays unavailable until a billing provider is configured, and opening a return page does not change your plan.
        </p>
        <div className="mt-10 grid gap-4 md:grid-cols-2">
          {PRICING_PLANS.map((plan) => (
            <article key={plan.id} className={`rounded-3xl border bg-surface p-6 shadow-sm ${plan.available ? "border-accent" : "border-line"}`}>
              <h2 className="font-serif text-3xl">{plan.name}</h2>
              <p className="mt-2 text-2xl">{plan.priceLabel}</p>
              <p className="mt-2 text-sm text-muted">{plan.note}</p>
              <ul className="mt-6 space-y-2 text-sm">
                {plan.features.map((feature) => (
                  <li key={feature}>{feature}</li>
                ))}
              </ul>
              <PlanAction plan={plan} />
            </article>
          ))}
        </div>
      </div>
    </SiteFrame>
  );
}
