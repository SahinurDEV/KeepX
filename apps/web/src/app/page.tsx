import Link from "next/link";
import { ProductPreview } from "@/components/product-preview";
import { SiteFrame } from "@/components/site-frame";
import { appName } from "@/lib/api";

const features = [
  ["Lists and inbox", "Capture anything, then sort it into lists when you know where it belongs."],
  ["Calendar", "Month, week, and day in your time zone. Move a task by choosing another day."],
  ["Repeating tasks", "Daily, weekly, monthly, and yearly rules, with a history of what you finished."],
  ["Reminders", "Save a reminder on the task. It shows in the app while the tab is open."],
  ["Search and filters", "Find a task by title, or narrow a list by priority."],
  ["One account", "Your lists stay on the server and reload with you. Other people cannot see them."],
];

export default function HomePage() {
  const name = appName();
  return (
    <SiteFrame>
      <section className="px-5 pb-14 pt-16 text-center md:pt-24">
        <h1 className="mx-auto max-w-4xl text-4xl font-semibold tracking-tight text-ink md:text-6xl">Plan the day. Finish the list.</h1>
        <p className="mx-auto mt-5 max-w-2xl text-lg leading-8 text-muted">
          {name} keeps tasks, lists, due dates, and a calendar in one place, so the work in front of you stays easy to see.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link className="rounded-full bg-accent px-6 py-2.5 text-sm font-medium text-accent-ink shadow-sm" href="/signup">
            Get started
          </Link>
          <Link className="rounded-full border border-line bg-surface px-6 py-2.5 text-sm text-ink" href="/download">
            Download
          </Link>
        </div>
      </section>
      <ProductPreview />
      <section className="mx-auto max-w-6xl px-5 py-20">
        <h2 className="text-center text-3xl font-semibold tracking-tight md:text-4xl">The tools that are in the app</h2>
        <p className="mx-auto mt-3 max-w-2xl text-center text-muted">These are the parts you can use after you create an account. Nothing here is a preview of a feature that is still missing.</p>
        <div className="mt-10 grid gap-4 md:grid-cols-3">
          {features.map(([title, copy]) => (
            <article key={title} className="rounded-2xl border border-line bg-surface p-6 text-left shadow-sm">
              <h3 className="text-lg font-semibold">{title}</h3>
              <p className="mt-2 text-sm leading-6 text-muted">{copy}</p>
            </article>
          ))}
        </div>
      </section>
      <section className="px-5 pb-20 text-center">
        <h2 className="text-3xl font-semibold tracking-tight">Start with an empty inbox.</h2>
        <p className="mx-auto mt-3 max-w-xl text-muted">The picture above is a sample layout. A new account does not include those tasks.</p>
        <Link className="mt-6 inline-flex rounded-full bg-accent px-6 py-2.5 text-sm font-medium text-accent-ink" href="/signup">
          Sign up for free
        </Link>
      </section>
    </SiteFrame>
  );
}