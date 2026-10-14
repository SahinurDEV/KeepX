import type { Metadata } from "next";
import Link from "next/link";
import { PRICING_PLANS } from "@vela/shared";
import { SiteFrame } from "@/components/site-frame";

export const metadata: Metadata = { title: "Pricing" };

export default function PricingPage() {
  return (
    <SiteFrame>
      <div className="mx-auto max-w-5xl px-5 py-16">
        <h1 className="font-serif text-5xl">Pricing</h1>
        <p className="mt-4 max-w-2xl text-muted">
          The personal workspace is free. There is no checkout, and the Plus column cannot be purchased.
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
              {plan.available ? (
                <Link className="mt-6 inline-flex rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink" href="/signup">
                  Create a free account
                </Link>
              ) : (
                <button className="mt-6 rounded-lg border border-line px-4 py-2 text-sm text-muted" disabled type="button">
                  Unavailable
                </button>
              )}
            </article>
          ))}
        </div>
      </div>
    </SiteFrame>
  );
}
