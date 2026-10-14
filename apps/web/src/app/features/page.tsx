import type { Metadata } from "next";
import { SiteFrame } from "@/components/site-frame";

export const metadata: Metadata = { title: "Features" };

const features = [
  ["Inbox, Today, Upcoming", "Separate what arrived, what is due, and what is coming next."],
  ["Lists and tags", "Group work your way. Each list has a color and an icon."],
  ["Priorities", "None, low, medium, and high, with filters on every list."],
  ["Subtasks", "Break a task down without leaving its detail panel."],
  ["Calendar", "Month, week, and day. Select a task, then choose a day to reschedule it."],
  ["Reminders", "Saved on the server and shown in the open app. Phone and desktop alerts are not available yet."],
  ["Search", "Find tasks by title or description."],
  ["Themes", "Light, dark, or match the system."],
];

export default function FeaturesPage() {
  return (
    <SiteFrame>
      <div className="mx-auto max-w-6xl px-5 py-16">
        <h1 className="font-serif text-5xl">What you can do</h1>
        <p className="mt-4 max-w-2xl text-muted">These are the features in the current web app. The signed-in screens use the same cards, type, and color as this page.</p>
        <ul className="mt-10 grid gap-4 md:grid-cols-2">
          {features.map(([title, copy]) => (
            <li key={title} className="rounded-3xl border border-line bg-surface p-6 shadow-sm">
              <h2 className="font-serif text-2xl">{title}</h2>
              <p className="mt-2 text-sm leading-6 text-muted">{copy}</p>
            </li>
          ))}
        </ul>
      </div>
    </SiteFrame>
  );
}
