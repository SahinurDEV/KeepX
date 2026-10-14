"use client";

import { ApiError } from "@vela/api-client";
import type { Priority, TaskDto } from "@vela/shared";
import { formatDueLabel, isOverdue } from "@vela/shared";
import { Badge } from "@vela/ui";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useOnline, useToast } from "@/components/providers";

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
}: {
  task: TaskDto;
  timeZone: string;
  selected: boolean;
  selecting: boolean;
  checked: boolean;
  onOpen: (id: string) => void;
  onToggleSelect: (id: string) => void;
  sortable: boolean;
}) {
  const online = useOnline();
  const toast = useToast();
  const queryClient = useQueryClient();
  const sort = useSortable({ id: task.id, disabled: !sortable });
  const now = new Date().toISOString();
  const overdue = task.dueAt ? isOverdue(task.dueAt, timeZone, now) && task.status === "open" : false;

  async function toggleComplete() {
    if (!online) {
      toast.push("You are offline. Reconnect to save changes.");
      return;
    }
    try {
      if (task.status === "completed") await api.uncompleteTask(task.id);
      else await api.completeTask(task.id);
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not update the task.");
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
        type="checkbox"
        className="mt-1 h-4 w-4 accent-accent"
        checked={task.status === "completed"}
        aria-label={`${task.status === "completed" ? "Mark open" : "Complete"} ${task.title}`}
        onChange={() => void toggleComplete()}
      />
      <button className="min-w-0 flex-1 text-left" type="button" onClick={() => onOpen(task.id)} {...sort.attributes} {...sort.listeners}>
        <span className={`block truncate ${task.status === "completed" ? "text-muted line-through" : ""}`}>{task.title}</span>
        <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
          {task.dueAt ? (
            <span className={overdue ? "text-danger" : ""}>{formatDueLabel(task.dueAt, timeZone, now, task.dueHasTime)}</span>
          ) : (
            <span>No date</span>
          )}
          {task.priority !== "none" ? <Badge tone={priorityTone[task.priority]}>{task.priority}</Badge> : null}
          {task.recurrence ? <span>Repeats</span> : null}
        </span>
      </button>
    </article>
  );
}

function bar(priority: Priority): string {
  if (priority === "high") return "bg-[hsl(var(--high))]";
  if (priority === "medium") return "bg-[hsl(var(--medium))]";
  if (priority === "low") return "bg-[hsl(var(--low))]";
  return "bg-line";
}
