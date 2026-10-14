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
        <p>The account stores your name, email, password hash, time zone, lists, tags, tasks, occurrence history, and in-app reminder records.</p>
        <p>Sessions use an httpOnly cookie. The server stores a hash of the session token, not the token itself.</p>
        <p>Task content is shown only to the signed-in account that owns it. The app does not sell task data and does not send it to an AI provider.</p>
        <p>Server logs include request id, path, status, and duration. They are not meant to include passwords or task text.</p>
      </article>
    </SiteFrame>
  );
}
