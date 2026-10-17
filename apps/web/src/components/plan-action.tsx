"use client";

import { ApiError } from "@vela/api-client";
import type { PricingPlan } from "@vela/shared";
import { Button } from "@vela/ui";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useToast } from "@/components/providers";
import { api } from "@/lib/api";

export function PlanAction({ plan }: { plan: PricingPlan }) {
  const meta = useQuery({ queryKey: ["meta"], queryFn: () => api.meta() });
  const toast = useToast();
  if (plan.available) {
    return (
      <Link className="mt-6 inline-flex rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-ink" href="/signup">
        Create a free account
      </Link>
    );
  }
  if (!meta.data?.billing) {
    return (
      <button className="mt-6 rounded-lg border border-line px-4 py-2 text-sm text-muted" disabled type="button">
        Unavailable
      </button>
    );
  }
  return (
    <Button
      id="continue-checkout"
      className="mt-6"
      type="button"
      aria-label="Continue to checkout"
      onClick={() => {
        void api
          .startCheckout()
          .then((result) => {
            const destination = new URL(result.url);
            if (destination.protocol !== "https:" || destination.hostname !== "checkout.stripe.com") {
              throw new Error("Checkout did not return a Stripe address.");
            }
            window.location.assign(destination.toString());
          })
          .catch((error: unknown) => {
            toast.push(error instanceof ApiError ? error.message : error instanceof Error ? error.message : "Checkout could not be started.");
            queueMicrotask(() => document.getElementById("continue-checkout")?.focus());
          });
      }}
    >
      Continue to checkout
    </Button>
  );
}
