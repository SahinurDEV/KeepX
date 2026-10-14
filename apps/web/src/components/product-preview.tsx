import { appName } from "@/lib/api";

const lists = ["Today", "Inbox", "Upcoming", "Calendar"];

const tasks = [
  { title: "Morning run", when: "Today", done: true },
  { title: "Outline the chapter", when: "Today", done: false },
  { title: "Send the invoice", when: "Today", done: false },
  { title: "Walk before dinner", when: "Tomorrow", done: false },
];

export function ProductPreview() {
  return (
    <div className="mx-auto w-full max-w-6xl overflow-hidden rounded-t-3xl border border-b-0 border-line bg-surface shadow-[0_30px_80px_-40px_hsl(var(--accent)/0.45)]">
      <div className="grid min-h-[420px] md:grid-cols-[200px_1fr_280px]">
        <aside className="hidden border-r border-line bg-sidebar/70 p-4 md:block">
          <p className="px-2 pb-4 text-sm font-semibold text-accent">{appName()}</p>
          <ul className="space-y-1 text-sm">
            {lists.map((item) => (
              <li key={item} className={`rounded-lg px-2 py-2 ${item === "Inbox" ? "bg-accent/10 font-medium text-accent" : "text-muted"}`}>
                {item}
              </li>
            ))}
          </ul>
        </aside>
        <section className="border-r border-line p-5">
          <h2 className="text-lg font-semibold">Inbox</h2>
          <ul className="mt-4">
            {tasks.map((task) => (
              <li key={task.title} className="flex items-center gap-3 border-b border-line py-3 text-sm">
                <span className={`h-4 w-4 rounded-full border ${task.done ? "border-accent bg-accent" : "border-line"}`} />
                <span className={`flex-1 ${task.done ? "text-muted line-through" : ""}`}>{task.title}</span>
                <span className="text-xs text-muted">{task.when}</span>
              </li>
            ))}
          </ul>
        </section>
        <aside className="hidden p-5 md:block">
          <p className="text-lg font-semibold">Outline the chapter</p>
          <p className="mt-2 text-sm leading-6 text-muted">Draft the opening, then list the sections that still need sources.</p>
          <dl className="mt-6 space-y-3 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-muted">List</dt>
              <dd>Inbox</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Date</dt>
              <dd>Today</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Priority</dt>
              <dd className="text-accent">High</dd>
            </div>
          </dl>
        </aside>
      </div>
    </div>
  );
}
