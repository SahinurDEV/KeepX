import type { Metadata } from "next";
import { SiteFrame } from "@/components/site-frame";
import { appName } from "@/lib/api";

export const metadata: Metadata = { title: "Help" };

export default function HelpPage() {
  const name = appName();
  return (
    <SiteFrame>
      <article className="mx-auto max-w-3xl space-y-8 px-5 py-16">
        <h1 className="font-serif text-5xl">Help</h1>
        <section>
          <h2 className="text-2xl font-medium">Create an account</h2>
          <p className="mt-2 text-muted">Open Sign up, choose a password of at least 10 characters, and you land in Inbox.</p>
        </section>
        <section>
          <h2 className="text-2xl font-medium">Add a task</h2>
          <p className="mt-2 text-muted">Type in the quick-add field and press Enter. Press C to focus that field. Open a task to set a date, priority, tags, subtasks, or a repeat rule.</p>
        </section>
        <section>
          <h2 className="text-2xl font-medium">Repeating tasks</h2>
          <p className="mt-2 text-muted">
            Completing a repeating task records that occurrence and moves the due date forward. Skip records the occurrence without treating it as finished work. Uncomplete restores the latest occurrence. Deleting removes the series.
          </p>
        </section>
        <section>
          <h2 className="text-2xl font-medium">Reminders</h2>
          <p className="mt-2 text-muted">
            A reminder is stored with the task. While {name} is open and you are online, a due reminder appears as a notice in the app. System notifications, email, and mobile push are not connected.
          </p>
        </section>
        <section>
          <h2 className="text-2xl font-medium">Offline</h2>
          <p className="mt-2 text-muted">If the browser is offline, changes stay disabled. There is no offline queue yet, so reconnect before editing.</p>
        </section>
        <section>
          <h2 className="text-2xl font-medium">Password recovery</h2>
          <p className="mt-2 text-muted">Recovery email is not configured. Change your password from Settings while you are signed in.</p>
        </section>
      </article>
    </SiteFrame>
  );
}
