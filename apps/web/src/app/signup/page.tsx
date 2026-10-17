import { Suspense } from "react";
import { AuthForm } from "@/components/auth-form";
import { SiteFrame } from "@/components/site-frame";

export default function SignupPage() {
  return (
    <SiteFrame>
      <div className="mx-auto max-w-md px-5 py-16">
        <div className="rounded-3xl border border-line bg-surface p-6 shadow-sm md:p-8">
        <h1 className="font-serif text-4xl">Create your account</h1>
        <div className="mt-6">
          <Suspense fallback={<p className="text-sm text-muted" role="status">Loading the form…</p>}>
            <AuthForm mode="signup" />
          </Suspense>
        </div>
        </div>
      </div>
    </SiteFrame>
  );
}
