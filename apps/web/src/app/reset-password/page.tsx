import type { Metadata } from "next";
import { Suspense } from "react";
import { ResetForm } from "@/components/reset-form";
import { SiteFrame } from "@/components/site-frame";

export const metadata: Metadata = { title: "Choose a new password" };

export default function ResetPasswordPage() {
  return (
    <SiteFrame>
      <div className="mx-auto max-w-md px-5 py-16">
        <div className="rounded-3xl border border-line bg-surface p-6 shadow-sm md:p-8">
          <h1 className="font-serif text-4xl">Choose a new password</h1>
          <Suspense fallback={<p className="mt-6 text-sm text-muted" role="status">Loading the form…</p>}>
            <ResetForm />
          </Suspense>
        </div>
      </div>
    </SiteFrame>
  );
}
