import type { Metadata } from "next";
import { ForgotForm } from "@/components/forgot-form";
import { SiteFrame } from "@/components/site-frame";

export const metadata: Metadata = { title: "Reset password" };

export default function ForgotPage() {
  return (
    <SiteFrame>
      <div className="mx-auto max-w-md px-5 py-16">
        <div className="rounded-3xl border border-line bg-surface p-6 shadow-sm md:p-8">
          <h1 className="font-serif text-4xl">Reset password</h1>
          <ForgotForm />
        </div>
      </div>
    </SiteFrame>
  );
}
