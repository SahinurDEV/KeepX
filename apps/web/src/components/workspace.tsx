"use client";

import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { ApiError } from "@vela/api-client";
import type { Priority } from "@vela/shared";
import { combineDateAndTime } from "@vela/shared";
import { Button, Input } from "@vela/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { CalendarBoard } from "@/components/calendar-board";
import { useOnline, useToast } from "@/components/providers";
import { TaskDetail } from "@/components/task-detail";
import { TaskRow } from "@/components/task-row";
import { api } from "@/lib/api";

export type WorkspaceView =
  | { kind: "inbox" | "today" | "upcoming" | "all" | "completed" | "calendar" }
  | { kind: "list"; listId: string }
  | { kind: "tag"; tagId: string }
  | { kind: "search"; query: string };

const titles: Record<string, string> = {
  inbox: "Inbox",
  today: "Today",
  upcoming: "Upcoming",
  all: "All tasks",
  completed: "Completed",
  calendar: "Calendar",
};

export function Workspace({ view }: { view: WorkspaceView }) {
  const online = useOnline();
  const toast = useToast();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.me(), retry: false });
  const lists = useQuery({ queryKey: ["lists"], queryFn: () => api.lists(), enabled: Boolean(me.data) });
  const tags = useQuery({ queryKey: ["tags"], queryFn: () => api.tags(), enabled: Boolean(me.data) });
  const [priority, setPriority] = useState<Priority | "">("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [checked, setChecked] = useState<string[]>([]);
  const [draftTitle, setDraftTitle] = useState("");
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const params = useMemo(() => {
    const base: Record<string, string | undefined> = {};
    if (priority) base.priority = priority;
    if (view.kind === "list") return { ...base, view: "list", listId: view.listId };
    if (view.kind === "tag") return { ...base, view: "tag", tagId: view.tagId };
    if (view.kind === "search") return { ...base, view: "search", q: view.query || undefined };
    if (view.kind === "calendar") return base;
    return { ...base, view: view.kind };
  }, [priority, view]);

  const tasks = useQuery({
    queryKey: ["tasks", params],
    queryFn: () => api.listTasks(params),
    enabled: Boolean(me.data) && view.kind !== "calendar",
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (event.key.toLowerCase() === "c" && !typing) {
        event.preventDefault();
        document.getElementById("quick-add")?.focus();
      }
      if (event.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const heading = headingFor(view, lists.data ?? [], tags.data ?? []);
  const rows = tasks.data?.tasks ?? [];
  const sortable = view.kind === "inbox" || view.kind === "list" || view.kind === "all";

  async function addTask() {
    const title = draftTitle.trim();
    if (!title) return;
    if (!online) {
      toast.push("You are offline. Reconnect to save changes.");
      return;
    }
    const inbox = (lists.data ?? []).find((list) => list.isInbox);
    const body: Record<string, unknown> = {
      title,
      listId: view.kind === "list" ? view.listId : inbox?.id,
    };
    if (view.kind === "tag") body.tagIds = [view.tagId];
    if (view.kind === "today" && me.data) {
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: me.data.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      body.dueAt = combineDateAndTime(today, null, me.data.timeZone).dueAt;
      body.dueHasTime = false;
    }
    try {
      await api.createTask(body, crypto.randomUUID());
      setDraftTitle("");
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not add the task.");
    }
  }

  async function onDragEnd(event: DragEndEvent) {
    if (!event.over || event.active.id === event.over.id) return;
    const ids = rows.map((task) => task.id);
    const from = ids.indexOf(String(event.active.id));
    const to = ids.indexOf(String(event.over.id));
    if (from < 0 || to < 0) return;
    const next = arrayMove(ids, from, to);
    try {
      await api.reorderTasks(next);
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not reorder tasks.");
    }
  }

  async function batch(action: "complete" | "delete") {
    if (!online) {
      toast.push("You are offline. Reconnect to save changes.");
      return;
    }
    const ids = [...checked];
    try {
      await api.batchTasks({ ids, action });
      setChecked([]);
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      if (action === "delete") {
        toast.push("Tasks deleted.", {
          label: "Undo",
          run: () => {
            void Promise.all(ids.map((id) => api.restoreTask(id))).then(() => queryClient.invalidateQueries({ queryKey: ["tasks"] }));
          },
        });
      }
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not update the selection.");
    }
  }

  return (
    <div className="flex min-h-full">
      <section className="min-w-0 flex-1 px-4 py-5 md:px-8">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-serif text-4xl">{heading}</h1>
            <p className="mt-1 text-sm text-muted">{copyFor(view)}</p>
          </div>
          {view.kind === "calendar" ? null : (
            <button className="text-sm text-accent" type="button" onClick={() => setSelecting((value) => !value)}>
              {selecting ? "Done selecting" : "Select"}
            </button>
          )}
        </div>
        {view.kind !== "completed" && view.kind !== "calendar" ? (
          <form
            className="mb-4 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void addTask();
            }}
          >
            <Input
              id="quick-add"
              aria-label="Quick add task"
              placeholder="Add a task and press Enter"
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
            />
            <Button type="submit">Add</Button>
          </form>
        ) : null}
        {view.kind !== "calendar" ? (
          <div className="mb-3 flex flex-wrap gap-2 text-sm">
            {(["", "high", "medium", "low", "none"] as const).map((item) => (
              <button
                key={item || "any"}
                type="button"
                className={`rounded-full px-3 py-1 ${priority === item ? "bg-accent text-accent-ink" : "bg-sidebar"}`}
                onClick={() => setPriority(item)}
              >
                {item === "" ? "Any priority" : item}
              </button>
            ))}
          </div>
        ) : null}
        {selecting && checked.length > 0 ? (
          <div className="mb-3 flex gap-2">
            <Button type="button" size="sm" onClick={() => void batch("complete")}>
              Complete selected
            </Button>
            <Button type="button" size="sm" variant="danger" onClick={() => void batch("delete")}>
              Delete selected
            </Button>
          </div>
        ) : null}
        {view.kind === "calendar" && me.data ? <CalendarBoard timeZone={me.data.timeZone} onOpen={setSelectedId} /> : null}
        {view.kind !== "calendar" && tasks.isLoading ? (
          <div className="space-y-2" aria-hidden="true">
            {Array.from({ length: 6 }, (_, index) => (
              <div key={index} className="h-14 animate-pulse rounded-lg bg-sidebar" />
            ))}
          </div>
        ) : null}
        {view.kind !== "calendar" && tasks.isError ? (
          <p className="rounded-lg border border-line bg-surface p-4 text-sm">The task list could not be loaded. Refresh and try again.</p>
        ) : null}
        {view.kind !== "calendar" && tasks.data && rows.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-line bg-surface px-4 py-14 text-center shadow-sm">
            <p className="font-medium">Nothing here yet</p>
            <p className="mt-1 text-sm text-muted">Add a task when you are ready. This view updates from your account.</p>
          </div>
        ) : null}
        {view.kind !== "calendar" && rows.length > 0 ? (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(event) => void onDragEnd(event)}>
            <SortableContext items={rows.map((task) => task.id)} strategy={verticalListSortingStrategy}>
              <div className="overflow-hidden rounded-3xl border border-line bg-surface shadow-sm">
                {rows.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    timeZone={me.data?.timeZone ?? "UTC"}
                    selected={selectedId === task.id}
                    selecting={selecting}
                    checked={checked.includes(task.id)}
                    sortable={sortable}
                    onOpen={setSelectedId}
                    onToggleSelect={(id) => setChecked((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        ) : null}
        {tasks.data?.truncated ? <p className="mt-3 text-sm text-muted">Showing the first 500 tasks.</p> : null}
        {tasks.data?.occurrences && tasks.data.occurrences.length > 0 ? (
          <div className="mt-6">
            <h2 className="text-sm font-medium uppercase tracking-wide text-muted">Repeat history</h2>
            <ul className="mt-2 divide-y divide-line rounded-xl border border-line bg-surface">
              {tasks.data.occurrences.map((item) => (
                <li key={item.id} className="px-3 py-2 text-sm">
                  {item.title} · {item.action} · {new Date(item.occurrenceDueAt).toLocaleString()}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
      {selectedId ? (
        <aside className="fixed inset-0 z-40 bg-surface lg:static lg:z-auto lg:block lg:w-[380px] lg:border-l lg:border-line">
          <TaskDetail taskId={selectedId} lists={lists.data ?? []} tags={tags.data ?? []} onClose={() => setSelectedId(null)} />
        </aside>
      ) : null}
    </div>
  );
}

function headingFor(view: WorkspaceView, lists: { id: string; name: string }[], tags: { id: string; name: string }[]): string {
  if (view.kind === "list") return lists.find((list) => list.id === view.listId)?.name ?? "List";
  if (view.kind === "tag") return tags.find((tag) => tag.id === view.tagId)?.name ?? "Tag";
  if (view.kind === "search") return view.query ? `Search “${view.query}”` : "Search";
  return titles[view.kind] ?? "Tasks";
}

function copyFor(view: WorkspaceView): string {
  if (view.kind === "today") return "Open tasks due today, plus anything overdue.";
  if (view.kind === "upcoming") return "Open tasks due after today.";
  if (view.kind === "completed") return "Finished tasks and the history of repeating ones.";
  if (view.kind === "calendar") return "Month, week, and day in your time zone.";
  if (view.kind === "search") return view.query ? "Matches in titles and descriptions." : "Use the search field above.";
  return "Drag a row to reorder. Press C to add a task.";
}
