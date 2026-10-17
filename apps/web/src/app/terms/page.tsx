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
        <p>The personal workspace is provided as available software. Windows, Linux, Android, Chrome, Edge, Firefox, and the Gmail project have install files. They are not store listings. The Android file is an unsigned debug APK. macOS and iOS downloads are not offered until a tested build is published.</p>
        <p>You are responsible for the tasks you store and for keeping your password private. There is no paid plan in this build and no payment is collected unless a billing provider is configured. A plan changes only after a signed billing notice. Opening a return page does not change it.</p>
        <p>The service may change or be taken offline. Settings can download a JSON file of your lists, tags, tasks, and occurrence history, and import that file as a copy. Import does not replace what is already there, restore sharing, or change your plan. The file does not include your password. It stops at 5,000 tasks and 5,000 occurrence rows. Settings can also delete the account after you enter the password. That removes your lists, tags, and tasks. Tasks other people added on your lists move to their Inbox. A recorded subscription blocks deletion, because this server does not cancel it.</p>
      </article>
    </SiteFrame>
  );
}
