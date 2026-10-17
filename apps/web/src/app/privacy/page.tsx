import type { Metadata } from "next";
import { SiteFrame } from "@/components/site-frame";
import { appName } from "@/lib/api";

export const metadata: Metadata = { title: "Privacy" };

export default function PrivacyPage() {
  const name = appName();
  return (
    <SiteFrame>
      <article className="mx-auto max-w-3xl space-y-4 px-5 py-16 text-muted">
        <h1 className="font-serif text-5xl text-ink">Privacy</h1>
        <p>This is a product draft for the {name} web app, not a lawyer-reviewed policy.</p>
        <p>The account stores your name, email, password hash, time zone, plan, whether you asked for email or push reminders, lists, tags, tasks, occurrence history, and reminder records. If you allow browser notifications, the push subscription is stored and is not shown again. Settings can download a JSON copy of your lists, tags, tasks, and occurrence history, including tasks on lists shared with you. That file can be imported as a copy into this account. It does not include your password or push subscriptions. Deleted tasks stay in Trash until they are restored or deleted forever. Settings can delete the account when you enter the password. That removes your data. Tasks other people added on your lists move to their Inbox. A recorded subscription blocks deletion, because this server does not cancel it. If you share a list, the people on that list can read and edit its tasks. They cannot see your other lists. If email reminders are on and mail is configured, a due task title is sent to your account address. If push reminders are on and a device is registered, that title is sent to the device. No payment is collected unless a billing provider is configured.</p>
        <p>Sessions use an httpOnly cookie. The server stores a hash of the session token, not the token itself. Settings lists the browsers signed in with your password and can sign one out. That list does not include the session secret. Signing a browser out does not revoke an app token.</p>
        <p>Task content is shown only to the signed-in account that owns it. The app does not sell task data and does not send it to an AI provider.</p>
        <p>Server logs include request id, path, status, and duration. They are not meant to include passwords or task text.</p>
      </article>
    </SiteFrame>
  );
}
