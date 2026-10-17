"use client";

import { ApiError } from "@vela/api-client";
import type { Priority, TaskDto } from "@vela/shared";
import { formatDueLabel, isOverdue } from "@vela/shared";
import { Badge } from "@vela/ui";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useQueryClient } from "@tanstack/react-query";
import { useToast, useOnline } from "@/components/providers";
import { useSync } from "@/components/sync-provider";
import { api } from "@/lib/api";
import { tagSwatch } from "@/lib/tag-color";

const priorityTone: Record<Priority, "neutral" | "low" | "medium" | "high"> = {
  none: "neutral",
  low: "low",
  medium: "medium",
  high: "high",
};

export function TaskRow({
  task,
  timeZone,
  selected,
  selecting,
  checked,
  onOpen,
  onToggleSelect,
  sortable,
  listName,
  tags,
}: {
  task: TaskDto;
  timeZone: string;
  selected: boolean;
  selecting: boolean;
  checked: boolean;
  onOpen: (id: string) => void;
  onToggleSelect: (id: string) => void;
  sortable: boolean;
  listName?: string;
  tags?: { id: string; name: string; color?: keyof typeof tagSwatch }[];
}) {
  const toast = useToast();
  const online = useOnline();
  const sync = useSync();
  const queryClient = useQueryClient();
  const sort = useSortable({ id: task.id, disabled: !sortable });
  const now = new Date().toISOString();
  const overdue = task.dueAt ? isOverdue(task.dueAt, timeZone, now) && task.status === "open" : false;

  async function toggleComplete() {
    const finishing = task.status !== "completed";
    const openSubtasks = finishing && !task.recurrence ? (task.openSubtaskCount ?? 0) : 0;
    const taskId = task.id;
    const focusComplete = () =>
      queueMicrotask(() => {
        const control = document.getElementById(`task-complete-${taskId}`);
        if (control) control.focus();
        else (document.getElementById(`task-open-${taskId}`) ?? document.getElementById("workspace-heading"))?.focus();
      });
    try {
      const result = finishing ? await sync.completeTask(task) : await sync.reopenTask(task);
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      await queryClient.invalidateQueries({ queryKey: ["task", taskId] });
      if (result === "queued") {
        toast.push("Saved on this device. It will sync when you reconnect.");
        focusComplete();
        return;
      }
      if (!finishing) {
        toast.push("Task reopened.", {
          label: "Undo",
          run: () => {
            if (!navigator.onLine) {
              toast.push("You are offline. Reconnect to complete that task.");
              focusComplete();
              return;
            }
            void api
              .completeTask(taskId)
              .then(() => {
                toast.push("Task completed.");
                focusComplete();
                return Promise.all([
                  queryClient.invalidateQueries({ queryKey: ["tasks"] }),
                  queryClient.invalidateQueries({ queryKey: ["task", taskId] }),
                ]);
              })
              .catch((error: unknown) => {
                void queryClient.invalidateQueries({ queryKey: ["tasks"] });
                toast.push(error instanceof ApiError ? error.message : "Could not complete the task.");
                focusComplete();
              });
          },
        });
        focusComplete();
        return;
      }
      const extra = openSubtasks === 1 ? " Its open subtask was completed too." : openSubtasks > 1 ? " Its open subtasks were completed too." : "";
      toast.push(`Task completed.${extra}`, {
        label: "Undo",
        run: () => {
          if (!navigator.onLine) {
            toast.push("You are offline. Reconnect to reopen that task.");
            focusComplete();
            return;
          }
          void api
            .uncompleteTask(taskId)
            .then(() => {
              toast.push("Task reopened.");
              focusComplete();
              return Promise.all([
                queryClient.invalidateQueries({ queryKey: ["tasks"] }),
                queryClient.invalidateQueries({ queryKey: ["task", taskId] }),
              ]);
            })
            .catch((error: unknown) => {
              void queryClient.invalidateQueries({ queryKey: ["tasks"] });
              toast.push(error instanceof ApiError ? error.message : "Could not reopen the task.");
              focusComplete();
            });
        },
      });
      focusComplete();
    } catch (error) {
      toast.push(
        error instanceof ApiError
          ? error.message
          : finishing
            ? "Could not complete the task."
            : "Could not reopen the task.",
      );
      focusComplete();
    }
  }

  async function pin() {
    const taskId = task.id;
    const focusPin = () =>
      queueMicrotask(() => {
        const control = document.getElementById(`task-pin-${taskId}`);
        if (control instanceof HTMLButtonElement && !control.disabled) {
          control.focus();
          return;
        }
        (document.getElementById(`task-open-${taskId}`) ?? document.getElementById("workspace-heading"))?.focus();
      });
    const nextPinned = !task.pinned;
    if (!online) {
      toast.push(nextPinned ? "You are offline. Reconnect to pin that task." : "You are offline. Reconnect to unpin that task.");
      focusPin();
      return;
    }
    try {
      await api.pinTask(taskId, nextPinned);
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      await queryClient.invalidateQueries({ queryKey: ["task", taskId] });
      toast.push(nextPinned ? "Pinned." : "Unpinned.", {
        label: "Undo",
        run: () => {
          if (!navigator.onLine) {
            toast.push(
              nextPinned ? "You are offline. Reconnect to unpin that task." : "You are offline. Reconnect to pin that task.",
            );
            focusPin();
            return;
          }
          void api
            .pinTask(taskId, !nextPinned)
            .then(() => {
              toast.push(nextPinned ? "Unpinned." : "Pinned.");
              focusPin();
              return Promise.all([
                queryClient.invalidateQueries({ queryKey: ["tasks"] }),
                queryClient.invalidateQueries({ queryKey: ["task", taskId] }),
              ]);
            })
            .catch((error: unknown) => {
              void queryClient.invalidateQueries({ queryKey: ["tasks"] });
              toast.push(
                error instanceof ApiError
                  ? error.message
                  : nextPinned
                    ? "Could not unpin the task."
                    : "Could not pin the task.",
              );
              focusPin();
            });
        },
      });
      focusPin();
    } catch (error) {
      toast.push(
        error instanceof ApiError
          ? error.message
          : nextPinned
            ? "Could not pin the task."
            : "Could not unpin the task.",
      );
      focusPin();
    }
  }

  async function postpone() {
    const openSubtasks = task.recurrence ? 0 : (task.openSubtaskCount ?? 0);
    const previousDue = task.dueAt;
    const previousHasTime = Boolean(task.dueHasTime);
    const taskId = task.id;
    const focusPostpone = () =>
      queueMicrotask(() => {
        const control = document.getElementById(`task-postpone-${taskId}`);
        if (control) control.focus();
        else (document.getElementById(`task-open-${taskId}`) ?? document.getElementById("workspace-heading"))?.focus();
      });
    try {
      const result = await sync.postponeTask(task);
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      await queryClient.invalidateQueries({ queryKey: ["task", taskId] });
      if (result === "queued") {
        toast.push("Saved on this device. It will sync when you reconnect.");
        focusPostpone();
        return;
      }
      const extra = openSubtasks === 1 ? " Its open subtask moved too." : openSubtasks > 1 ? " Its open subtasks moved too." : "";
      toast.push(`Postponed.${extra}`, {
        label: "Undo",
        run: () => {
          if (!navigator.onLine) {
            toast.push("You are offline. Reconnect to restore the date.");
            focusPostpone();
            return;
          }
          void api
            .batchTasks({
              ids: [taskId],
              action: "due",
              dueAt: previousDue,
              dueHasTime: previousHasTime,
            })
            .then(() => {
              toast.push("Restored the date.");
              focusPostpone();
              return Promise.all([
                queryClient.invalidateQueries({ queryKey: ["tasks"] }),
                queryClient.invalidateQueries({ queryKey: ["task", taskId] }),
              ]);
            })
            .catch((error: unknown) => {
              void queryClient.invalidateQueries({ queryKey: ["tasks"] });
              toast.push(error instanceof ApiError ? error.message : "Could not restore the date.");
              focusPostpone();
            });
        },
      });
      focusPostpone();
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not postpone the task.");
      focusPostpone();
    }
  }

  return (
    <article
      ref={sort.setNodeRef}
      style={{ transform: CSS.Transform.toString(sort.transform), transition: sort.transition }}
      className={`flex items-start gap-3 border-b border-line px-4 py-3.5 last:border-b-0 ${selected ? "bg-sidebar" : "bg-surface"}`}
      data-testid="task-row"
    >
      <span className={`mt-1 h-8 w-1 rounded-full ${bar(task.priority)}`} aria-hidden="true" />
      {selecting ? (
        <input
          type="checkbox"
          className="mt-1"
          checked={checked}
          aria-label={`Select ${task.title}`}
          onChange={() => onToggleSelect(task.id)}
        />
      ) : null}
      <input
        id={`task-complete-${task.id}`}
        type="checkbox"
        className="mt-1 h-4 w-4 accent-accent"
        checked={task.status === "completed"}
        aria-label={`${task.status === "completed" ? "Mark open" : "Complete"} ${task.title}`}
        onChange={() => void toggleComplete()}
      />
      <button
        id={`task-open-${task.id}`}
        className="min-w-0 flex-1 text-left"
        type="button"
        aria-label={`Open ${task.title}`}
        onClick={() => onOpen(task.id)}
        {...sort.attributes}
        {...sort.listeners}
      >
        <span className={`block truncate ${task.status === "completed" ? "text-muted line-through" : ""}`}>{task.title}</span>
        {snippet(task.description) ? <span className="mt-0.5 block truncate text-xs text-muted">{snippet(task.description)}</span> : null}
        <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
          {task.dueAt ? (
            <span className={overdue ? "text-danger" : ""}>
              {formatDueLabel(task.dueAt, timeZone, now, task.dueHasTime)}
              {overdue ? " · Overdue" : ""}
            </span>
          ) : (
            <span>No date</span>
          )}
          {task.status === "completed" && task.completedAt ? <span>Finished {formatDueLabel(task.completedAt, timeZone, now, false)}</span> : null}
          {task.startAt ? (
            <span>
              Starts {formatDueLabel(task.startAt, timeZone, now, false)}
              {task.startAt > now ? " · Not started" : ""}
            </span>
          ) : null}
          {listName ? <span>{listName}</span> : null}
          {task.priority !== "none" ? <Badge tone={priorityTone[task.priority]}>{task.priority}</Badge> : null}
          {taskTags(task.tagIds, tags).map((tag) => (
            <span key={tag.id} className="inline-flex items-center gap-1">
              {tag.color ? <span className={`inline-block h-2 w-2 rounded-full ${tagSwatch[tag.color]}`} aria-hidden="true" /> : null}
              {tag.name}
            </span>
          ))}
          {task.estimatedMinutes !== null ? <span>Estimate {task.estimatedMinutes} min</span> : null}
          {task.reminderOffsetMinutes !== null ? <span>{reminderLabel(task.reminderOffsetMinutes)}</span> : null}
          {task.parentTitle ? <span>Subtask of {task.parentTitle}</span> : null}
          {task.subtaskCount ? (
            <span>
              {task.openSubtaskCount ?? 0} of {task.subtaskCount} subtasks
            </span>
          ) : null}
          {task.pinned ? <span>Pinned</span> : null}
          {task.assigneeName ? <span>Assigned to {task.assigneeName}</span> : null}
          {task.recurrence ? <span>{repeatLabel(task.recurrence, timeZone)}</span> : null}
          {task.occurrenceOriginalDueAt ? <span>This date</span> : null}
        </span>
      </button>
      {task.status === "open" ? (
        <button
          id={`task-pin-${task.id}`}
          className="mt-1 text-xs text-muted disabled:opacity-50"
          type="button"
          aria-label={`${task.pinned ? "Unpin" : "Pin"} ${task.title}`}
          aria-pressed={task.pinned}
          disabled={!online}
          onClick={() => void pin()}
        >
          {task.pinned ? "Unpin" : "Pin"}
        </button>
      ) : null}
      {task.status === "open" ? (
        <button
          id={`task-postpone-${task.id}`}
          className="mt-1 text-xs text-muted"
          type="button"
          aria-label={`Postpone ${task.title}`}
          onClick={() => void postpone()}
        >
          Postpone
        </button>
      ) : null}
    </article>
  );
}

function bar(priority: Priority): string {
  if (priority === "high") return "bg-[hsl(var(--high))]";
  if (priority === "medium") return "bg-[hsl(var(--medium))]";
  if (priority === "low") return "bg-[hsl(var(--low))]";
  return "bg-line";
}

function reminderLabel(minutes: number): string {
  if (minutes === 0) return "At the due time";
  if (minutes === 15) return "15 min before";
  if (minutes === 60) return "1 hour before";
  if (minutes === 1440) return "1 day before";
  if (minutes % 1440 === 0) return `${minutes / 1440} days before`;
  if (minutes % 60 === 0) return `${minutes / 60} hours before`;
  return `${minutes} min before`;
}

function repeatLabel(rule: NonNullable<TaskDto["recurrence"]>, timeZone: string): string {
  const units: Record<typeof rule.frequency, string> = {
    daily: "days",
    weekly: "weeks",
    monthly: "months",
    yearly: "years",
  };
  const base = rule.interval > 1 ? `Repeats every ${rule.interval} ${units[rule.frequency]}` : `Repeats ${rule.frequency}`;
  const times = rule.count ? `, ${rule.count} times` : "";
  const until = rule.until ? ` until ${formatDueLabel(rule.until, timeZone, new Date().toISOString(), false)}` : "";
  if (rule.frequency !== "weekly" || !rule.byWeekday || rule.byWeekday.length === 0) return `${base}${times}${until}`;
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const days = [...rule.byWeekday]
    .sort((left, right) => left - right)
    .flatMap((day) => (names[day - 1] ? [names[day - 1]] : []));
  return days.length > 0 ? `${base} on ${days.join(", ")}${times}${until}` : `${base}${times}${until}`;
}

function taskTags(ids: string[], tags?: { id: string; name: string; color?: keyof typeof tagSwatch }[]): { id: string; name: string; color?: keyof typeof tagSwatch }[] {
  if (!tags || ids.length === 0) return [];
  return ids.flatMap((id) => {
    const tag = tags.find((item) => item.id === id);
    return tag ? [tag] : [];
  });
}

function snippet(description: string): string {
  const line = description.replace(/\s+/g, " ").trim();
  if (!line) return "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}
