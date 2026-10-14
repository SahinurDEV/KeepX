import type { Metadata } from "next";
import { SiteFrame } from "@/components/site-frame";
import { appName } from "@/lib/api";

export const metadata: Metadata = { title: "Terms" };

export default function TermsPage() {
  const name = appName();
  return (
    <SiteFrame>
      <article className="mx-auto max-w-3xl space-y-4 px-5 py-16 text-muted">
        <h1 className="font-serif text-5xl text-ink">Terms</h1>
        <p>This is a product draft for {name}, not a lawyer-reviewed agreement.</p>
        <p>The personal workspace is provided as available software. Desktop, mobile, and extension downloads are not offered until a tested build is published.</p>
        <p>You are responsible for the tasks you store and for keeping your password private. There is no paid plan and no payment is collected.</p>
        <p>The service may change or be taken offline. Export of a full archive is not available in this version, so keep your own copy of anything you cannot lose.</p>
      </article>
    </SiteFrame>
  );
}
