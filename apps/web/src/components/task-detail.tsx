"use client";

import { ApiError } from "@vela/api-client";
import type { ListDto, Priority, TagDto } from "@vela/shared";
import { combineDateAndTime, formatDueLabel, isOverdue, splitDue } from "@vela/shared";
import { Button, Input, Textarea } from "@vela/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useOnline, useToast } from "@/components/providers";
import { useSync } from "@/components/sync-provider";
import { api } from "@/lib/api";
import { tagSwatch } from "@/lib/tag-color";

const reminders = [
  ["", "No reminder"],
  ["0", "At the due time"],
  ["15", "15 minutes before"],
  ["60", "1 hour before"],
  ["1440", "1 day before"],
] as const;

function canFocusTaskDetail(element: HTMLElement | null): element is HTMLElement {
  if (!element || !document.contains(element)) return false;
  if (
    (element instanceof HTMLButtonElement ||
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement) &&
    element.disabled
  ) {
    return false;
  }
  return true;
}

function focusTaskDetailIds(...ids: string[]) {
  queueMicrotask(() => {
    for (const id of ids) {
      const target = document.getElementById(id);
      if (!canFocusTaskDetail(target)) continue;
      target.focus();
      return;
    }
  });
}

function focusTaskDetailQuery(...selectors: string[]) {
  queueMicrotask(() => {
    for (const selector of selectors) {
      const target = document.querySelector<HTMLElement>(selector);
      if (!canFocusTaskDetail(target)) continue;
      target.focus();
      return;
    }
  });
}

export function TaskDetail({
  taskId,
  lists,
  tags,
  listsFailed = false,
  listsLoading = false,
  tagsFailed = false,
  tagsLoading = false,
  onRetryLists,
  onRetryTags,
  onClose,
  onOpen,
}: {
  taskId: string;
  lists: ListDto[];
  tags: TagDto[];
  listsFailed?: boolean;
  listsLoading?: boolean;
  tagsFailed?: boolean;
  tagsLoading?: boolean;
  onRetryLists?: () => void;
  onRetryTags?: () => void;
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  const online = useOnline();
  const toast = useToast();
  const sync = useSync();
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ["task", taskId], queryFn: () => api.getTask(taskId) });
  const task = detail.data?.task;
  const members = useQuery({
    queryKey: ["members", task?.listId],
    queryFn: () => api.listMembers(task?.listId ?? ""),
    enabled: Boolean(task && task.status === "open"),
  });
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [listId, setListId] = useState("");
  const [priority, setPriority] = useState<Priority>("none");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [startDate, setStartDate] = useState("");
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [estimated, setEstimated] = useState("");
  const [reminder, setReminder] = useState("");
  const [frequency, setFrequency] = useState("");
  const [interval, setIntervalValue] = useState("1");
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [count, setCount] = useState("");
  const [untilDate, setUntilDate] = useState("");
  const [scope, setScope] = useState<"this" | "following">("following");
  const [subtask, setSubtask] = useState("");

  useEffect(() => {
    if (!task) return;
    setTitle(task.title);
    setDescription(task.description);
    setListId(task.listId);
    setPriority(task.priority);
    if (task.dueAt) {
      const parts = splitDue(task.dueAt, task.timeZone, task.dueHasTime);
      setDate(parts.date);
      setTime(parts.time);
    } else {
      setDate("");
      setTime("");
    }
    setStartDate(task.startAt ? splitDue(task.startAt, task.timeZone, false).date : "");
    setTagIds(task.tagIds);
    setEstimated(task.estimatedMinutes ? String(task.estimatedMinutes) : "");
    setReminder(task.reminderOffsetMinutes === null ? "" : String(task.reminderOffsetMinutes));
    setFrequency(task.recurrence?.frequency ?? "");
    setIntervalValue(String(task.recurrence?.interval ?? 1));
    setWeekdays(task.recurrence?.byWeekday ?? []);
    setCount(task.recurrence?.count ? String(task.recurrence.count) : "");
    setUntilDate(task.recurrence?.until ? splitDue(task.recurrence.until, task.timeZone, false).date : "");
    setScope(task.occurrenceOriginalDueAt ? "this" : "following");
  }, [task]);

  useEffect(() => {
    setSubtask("");
  }, [taskId]);

  async function assign(userId: string | null) {
    if (!task) return;
    const focusAssign = () => focusTaskDetailIds("task-assign", "task-save");
    if (!online) {
      toast.push(userId ? "You are offline. Reconnect to assign that task." : "You are offline. Reconnect to clear the assignment.");
      focusAssign();
      return;
    }
    const previous = task.assigneeId ?? null;
    if (previous === userId) {
      toast.push(userId ? "That task is already assigned to that person." : "That task is already unassigned.");
      focusAssign();
      return;
    }
    const taskIdToAssign = task.id;
    try {
      await api.assignTask(taskIdToAssign, userId);
      await refresh();
      toast.push(userId ? "Task assigned." : "Assignment cleared.", {
        label: "Undo",
        run: () => {
          if (!navigator.onLine) {
            toast.push(
              previous
                ? "You are offline. Reconnect to restore the previous assignee."
                : "You are offline. Reconnect to clear the assignment.",
            );
            focusAssign();
            return;
          }
          void api
            .assignTask(taskIdToAssign, previous)
            .then(() => refresh())
            .then(() => {
              toast.push(previous ? "Restored the assignee." : "Assignment cleared.");
              focusAssign();
            })
            .catch((error: unknown) => {
              void refresh();
              toast.push(
                error instanceof ApiError
                  ? error.message
                  : previous
                    ? "Could not restore the previous assignee."
                    : "Could not clear the assignment.",
              );
              focusAssign();
            });
        },
      });
      focusAssign();
    } catch (error) {
      toast.push(
        error instanceof ApiError
          ? error.message
          : userId
            ? "Could not assign the task."
            : "Could not clear the assignment.",
      );
      focusAssign();
    }
  }

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["tasks"] });
    await queryClient.invalidateQueries({ queryKey: ["task", taskId] });
  }

  async function save() {
    if (!task) return;
    const focusField = (id: string) =>
      focusTaskDetailIds(id, "task-save", "quick-add", "workspace-heading");
    const focusSave = () => focusField("task-save");
    if (estimated.trim() !== "") {
      const minutes = Number(estimated);
      if (!Number.isInteger(minutes) || minutes < 0 || minutes > 100000) {
        toast.push("Choose a whole number of minutes.");
        focusField("task-estimate");
        return;
      }
    }
    if (frequency) {
      const every = Number(interval);
      if (!Number.isInteger(every) || every < 1 || every > 99) {
        toast.push("Choose a whole number from 1 to 99.");
        focusField("task-repeat-interval");
        return;
      }
      if (count.trim() !== "") {
        const times = Number(count);
        if (!Number.isInteger(times) || times < 1 || times > 999) {
          toast.push("Choose how many times it repeats, from 1 to 999.");
          focusField("task-repeat-count");
          return;
        }
      }
      if (untilDate) {
        try {
          combineDateAndTime(untilDate, "23:59", task.timeZone);
        } catch {
          toast.push("Choose a valid end date.");
          focusField("task-repeat-until");
          return;
        }
      }
    }
    try {
      let dueAt: string | null = null;
      let dueHasTime = false;
      if (date) {
        const combined = combineDateAndTime(date, time || null, task.timeZone);
        dueAt = combined.dueAt;
        dueHasTime = combined.dueHasTime;
      }
      const startAt = startDate ? combineDateAndTime(startDate, null, task.timeZone).dueAt : null;
      const until = untilDate ? combineDateAndTime(untilDate, "23:59", task.timeZone).dueAt : undefined;
      const savedUntil = task.recurrence?.until ? splitDue(task.recurrence.until, task.timeZone, false).date : "";
      const seriesChanged =
        listId !== task.listId ||
        startDate !== (task.startAt ? splitDue(task.startAt, task.timeZone, false).date : "") ||
        estimated !== (task.estimatedMinutes ? String(task.estimatedMinutes) : "") ||
        frequency !== (task.recurrence?.frequency ?? "") ||
        (frequency ? Number(interval) || 1 : 1) !== (task.recurrence?.interval ?? 1) ||
        count !== (task.recurrence?.count ? String(task.recurrence.count) : "") ||
        untilDate !== savedUntil ||
        JSON.stringify([...tagIds].sort()) !== JSON.stringify([...task.tagIds].sort()) ||
        JSON.stringify([...weekdays].sort()) !== JSON.stringify([...(task.recurrence?.byWeekday ?? [])].sort());
      const tell = (result: "saved" | "queued" | "attention", saved: string, previous: Record<string, unknown> | null) => {
        if (result === "queued") {
          toast.push("Saved on this device. It will sync when you reconnect.");
          focusSave();
          return;
        }
        if (result === "attention") {
          toast.push("This change needs a choice before it can sync.");
          focusSave();
          return;
        }
        if (!previous) {
          toast.push(saved);
          focusSave();
          return;
        }
        const savedTaskId = task.id;
        toast.push(saved, {
          label: "Undo",
          run: () => {
            if (!navigator.onLine) {
              toast.push("You are offline. Reconnect to restore the previous details.");
              focusSave();
              return;
            }
            void api
              .getTask(savedTaskId)
              .then((detail) => sync.saveTask(detail.task, previous))
              .then((undoResult) => {
                if (undoResult === "queued") {
                  toast.push("Saved on this device. It will sync when you reconnect.");
                  focusSave();
                } else if (undoResult === "attention") {
                  toast.push("This change needs a choice before it can sync.");
                  focusSave();
                } else {
                  toast.push("Restored the previous details.");
                  focusSave();
                }
                return refresh();
              })
              .then(() => focusSave())
              .catch((error: unknown) => {
                void refresh();
                toast.push(error instanceof ApiError ? error.message : "Could not restore the previous details.");
                focusSave();
              });
          },
        });
        focusSave();
      };
      if (task.recurrence && scope === "this") {
        if (seriesChanged) {
          toast.push("Choose This and future to change the repeat rule, list, tags, start date, or estimate.");
          focusField("task-apply-scope");
          return;
        }
        const sameDate =
          title === task.title &&
          description === task.description &&
          priority === task.priority &&
          (dueAt ?? null) === (task.dueAt ?? null) &&
          dueHasTime === Boolean(task.dueHasTime) &&
          (reminder === "" ? null : Number(reminder)) === (task.reminderOffsetMinutes ?? null);
        if (sameDate) {
          toast.push("That date already has those details.");
          focusSave();
          return;
        }
        const previous = {
          title: task.title,
          description: task.description,
          priority: task.priority,
          dueAt: task.dueAt,
          dueHasTime: task.dueHasTime,
          reminderOffsetMinutes: task.reminderOffsetMinutes,
          occurrenceScope: "this" as const,
        };
        const result = await sync.saveTask(task, {
          title,
          description,
          priority,
          dueAt,
          dueHasTime,
          reminderOffsetMinutes: reminder === "" ? null : Number(reminder),
          occurrenceScope: "this",
        });
        await refresh();
        tell(result, "This date was saved. The rest of the series is unchanged.", previous);
        return;
      }
      const sameTask =
        title === task.title &&
        description === task.description &&
        listId === task.listId &&
        priority === task.priority &&
        (dueAt ?? null) === (task.dueAt ?? null) &&
        dueHasTime === Boolean(task.dueHasTime) &&
        (startAt ?? null) === (task.startAt ?? null) &&
        (estimated ? Number(estimated) : null) === (task.estimatedMinutes ?? null) &&
        (reminder === "" ? null : Number(reminder)) === (task.reminderOffsetMinutes ?? null) &&
        JSON.stringify([...tagIds].sort()) === JSON.stringify([...task.tagIds].sort()) &&
        frequency === (task.recurrence?.frequency ?? "") &&
        (frequency ? Number(interval) || 1 : 1) === (task.recurrence?.interval ?? 1) &&
        count === (task.recurrence?.count ? String(task.recurrence.count) : "") &&
        untilDate === savedUntil &&
        JSON.stringify([...weekdays].sort()) === JSON.stringify([...(task.recurrence?.byWeekday ?? [])].sort());
      if (sameTask) {
        toast.push("That task already has those details.");
        focusSave();
        return;
      }
      const previous: Record<string, unknown> = {
        title: task.title,
        description: task.description,
        listId: task.listId,
        priority: task.priority,
        dueAt: task.dueAt,
        dueHasTime: task.dueHasTime,
        startAt: task.startAt,
        tagIds: task.tagIds,
        estimatedMinutes: task.estimatedMinutes,
        reminderOffsetMinutes: task.reminderOffsetMinutes,
        recurrence: task.recurrence,
        ...(task.recurrence || frequency ? { occurrenceScope: "following" as const } : {}),
      };
      const result = await sync.saveTask(task, {
        title,
        description,
        listId,
        priority,
        dueAt,
        dueHasTime,
        startAt,
        tagIds,
        estimatedMinutes: estimated ? Number(estimated) : null,
        reminderOffsetMinutes: reminder === "" ? null : Number(reminder),
        ...(task.recurrence || frequency ? { occurrenceScope: "following" as const } : {}),
        recurrence: frequency
          ? {
              frequency,
              interval: Number(interval) || 1,
              ...(frequency === "weekly" && weekdays.length > 0 ? { byWeekday: weekdays } : {}),
              ...(count ? { count: Number(count) } : {}),
              ...(until ? { until } : {}),
            }
          : null,
      });
      await refresh();
      tell(result, "Task saved.", previous);
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not save the task.");
      focusSave();
    }
  }

  async function moveSubtask(index: number, direction: -1 | 1) {
    const items = detail.data?.subtasks ?? [];
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= items.length) return;
    const previous = items.map((item) => item.id);
    const ids = [...previous];
    const current = ids[index];
    const neighbor = ids[nextIndex];
    if (!current || !neighbor) return;
    ids[index] = neighbor;
    ids[nextIndex] = current;
    const action = direction < 0 ? "up" : "down";
    const focusMove = () =>
      queueMicrotask(() => {
        const preferred = document.querySelector<HTMLElement>(`[data-subtask-action="${action}-${current}"]`);
        if (canFocusTaskDetail(preferred)) {
          preferred.focus();
          return;
        }
        const other = document.querySelector<HTMLElement>(
          `[data-subtask-action="${action === "up" ? "down" : "up"}-${current}"]`,
        );
        if (canFocusTaskDetail(other)) {
          other.focus();
          return;
        }
        for (const id of ["task-subtask", "task-save"] as const) {
          const el = document.getElementById(id);
          if (canFocusTaskDetail(el)) {
            el.focus();
            return;
          }
        }
      });
    if (!online) {
      toast.push("You are offline. Reconnect to reorder subtasks.");
      focusMove();
      return;
    }
    try {
      await api.reorderTasks(ids);
      await refresh();
      toast.push(direction < 0 ? "Subtask moved up." : "Subtask moved down.", {
        label: "Undo",
        run: () => {
          if (!navigator.onLine) {
            toast.push("You are offline. Reconnect to restore the previous order.");
            focusMove();
            return;
          }
          void api
            .reorderTasks(previous)
            .then(() => refresh())
            .then(() => {
              toast.push("Restored the subtask order.");
              focusMove();
            })
            .catch((error: unknown) => {
              void refresh();
              toast.push(error instanceof ApiError ? error.message : "Could not restore the subtask order.");
              focusMove();
            });
        },
      });
      focusMove();
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not move the subtask.");
      focusMove();
    }
  }

  async function run(
    action: () => Promise<unknown>,
    message: string,
    focusId?: string,
    offlineMessage = "You are offline. Reconnect to update that task.",
    failureMessage = "Could not update the task.",
  ) {
    const focusControl = () =>
      focusTaskDetailIds(...(focusId ? [focusId, "task-subtask", "task-save"] : ["task-subtask", "task-save"]));
    if (!online) {
      toast.push(offlineMessage);
      focusControl();
      return;
    }
    try {
      await action();
      await refresh();
      toast.push(message);
      focusControl();
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : failureMessage);
      focusControl();
    }
  }

  if (detail.isError) {
    return (
      <div className="space-y-3 p-4 text-sm">
        <p>This task could not be loaded.</p>
        <div className="flex flex-wrap gap-3">
          <button className="text-accent" type="button" aria-label="This task could not be loaded. Try again" onClick={() => void detail.refetch()}>
            Try again
          </button>
          <button className="text-muted" type="button" aria-label="Close Task details" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    );
  }

  if (detail.isLoading || !task) {
    return (
      <div className="space-y-3 p-4 text-sm">
        <h2 id="task-detail-title" className="font-medium">
          Task details
        </h2>
        <p className="text-muted" role="status">
          Loading task…
        </p>
        <button className="text-muted" type="button" autoFocus aria-label="Close Task details" onClick={onClose}>
          Close
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 id="task-detail-title" className="font-medium">
          Task details
        </h2>
        <button type="button" className="text-sm text-muted" autoFocus aria-label="Close Task details" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {task.parentId && task.parentTitle ? (
          <button type="button" className="text-left text-xs text-muted" aria-label={`Open ${task.parentTitle}`} onClick={() => onOpen(task.parentId ?? "")}>
            Subtask of {task.parentTitle}
          </button>
        ) : null}
        <Input aria-label="Title" value={title} onChange={(event) => setTitle(event.target.value)} />
        <Textarea aria-label="Description" value={description} onChange={(event) => setDescription(event.target.value)} />
        <label className="block text-sm">
          List
          <select
            className="mt-1 h-10 w-full rounded-lg border border-line bg-surface px-2"
            value={listId}
            onChange={(event) => setListId(event.target.value)}
            disabled={listsFailed || listsLoading}
          >
            {listsLoading && !lists.some((list) => list.id === listId) ? <option value={listId}>Loading lists…</option> : null}
            {listsFailed && !lists.some((list) => list.id === listId) ? <option value={listId}>List unavailable</option> : null}
            {lists.map((list) => (
              <option key={list.id} value={list.id}>
                {list.name}
              </option>
            ))}
          </select>
        </label>
        {listsFailed ? (
          <button className="text-sm text-accent" type="button" aria-label="Retry lists in Task details" onClick={() => onRetryLists?.()}>
            Retry lists
          </button>
        ) : listsLoading ? (
          <p className="text-sm text-muted" role="status">
            Loading lists…
          </p>
        ) : null}
        {task?.status === "open" ? (
          <label className="block text-sm">
            Assigned to
            <select
              id="task-assign"
              aria-label="Assigned to"
              className="mt-1 h-10 w-full rounded-lg border border-line bg-surface px-2"
              value={task.assigneeId ?? ""}
              onChange={(event) => void assign(event.target.value || null)}
              disabled={!online || members.isError || members.isLoading}
            >
              <option value="">Nobody</option>
              {members.isLoading && task.assigneeId && !(members.data ?? []).some((member) => member.id === task.assigneeId) ? (
                <option value={task.assigneeId}>{task.assigneeName ?? "Loading…"}</option>
              ) : null}
              {(members.data ?? []).map((member) => (
                <option key={member.id} value={member.id}>
                  {member.email}
                </option>
              ))}
            </select>
          </label>
          {members.isError ? (
            <button className="text-sm text-accent" type="button" aria-label="Retry assignees in Task details" onClick={() => void members.refetch()}>
              Retry assignees
            </button>
          ) : members.isLoading ? (
            <p className="text-sm text-muted" role="status">
              Loading people…
            </p>
          ) : null}
        ) : null}
        <label className="block text-sm">
          Priority
          <select className="mt-1 h-10 w-full rounded-lg border border-line bg-surface px-2" value={priority} onChange={(event) => setPriority(event.target.value as Priority)}>
            <option value="none">None</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-sm">
            Due date
            <Input className="mt-1" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </label>
          <label className="text-sm">
            Time
            <Input className="mt-1" type="time" value={time} onChange={(event) => setTime(event.target.value)} />
          </label>
        </div>
        <label className="block text-sm">
          Start date
          <Input className="mt-1" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
        </label>
        <fieldset>
          <legend className="text-sm">Tags</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {tagsFailed ? (
              <button className="text-sm text-accent" type="button" aria-label="Retry tags in Task details" onClick={() => onRetryTags?.()}>
                Retry tags
              </button>
            ) : tagsLoading ? (
              <span className="text-sm text-muted" role="status">
                Loading tags…
              </span>
            ) : (
              <>
                {tags.map((tag) => (
                  <label key={tag.id} className="flex items-center gap-1 text-sm">
                    <input
                      type="checkbox"
                      checked={tagIds.includes(tag.id)}
                      onChange={() => setTagIds((current) => (current.includes(tag.id) ? current.filter((id) => id !== tag.id) : [...current, tag.id]))}
                    />
                    <span className={`inline-block h-2 w-2 rounded-full ${tagSwatch[tag.color]}`} aria-hidden="true" />
                    {tag.name}
                  </label>
                ))}
                {tags.length === 0 ? <span className="text-sm text-muted">No tags yet.</span> : null}
              </>
            )}
          </div>
        </fieldset>
        <label className="block text-sm">
          Estimated minutes
          <Input
            id="task-estimate"
            className="mt-1"
            inputMode="numeric"
            aria-label="Estimated minutes"
            value={estimated}
            onChange={(event) => setEstimated(event.target.value)}
          />
        </label>
        <label className="block text-sm">
          Reminder
          <select className="mt-1 h-10 w-full rounded-lg border border-line bg-surface px-2" value={reminder} onChange={(event) => setReminder(event.target.value)}>
            {reminders.map(([value, label]) => (
              <option key={label} value={value}>
                {label}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-muted">Saved on the server. A notice appears while this tab is open. Email is sent only when Settings asks for it and mail is configured.</span>
        </label>
        <label className="block text-sm">
          Repeat
          <select className="mt-1 h-10 w-full rounded-lg border border-line bg-surface px-2" value={frequency} onChange={(event) => setFrequency(event.target.value)}>
            <option value="">Does not repeat</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly</option>
          </select>
        </label>
        {frequency ? (
          <div className="grid grid-cols-2 gap-2">
            <label className="text-sm">
              Interval
              <Input
                id="task-repeat-interval"
                className="mt-1"
                inputMode="numeric"
                aria-label="Repeat interval"
                value={interval}
                onChange={(event) => setIntervalValue(event.target.value)}
              />
            </label>
            <label className="text-sm">
              Occurrences
              <Input
                id="task-repeat-count"
                className="mt-1"
                inputMode="numeric"
                aria-label="Repeat occurrences"
                value={count}
                placeholder="Unlimited"
                onChange={(event) => setCount(event.target.value)}
              />
            </label>
          </div>
        ) : null}
        {frequency ? (
          <label className="block text-sm">
            End date
            <Input
              id="task-repeat-until"
              className="mt-1"
              type="date"
              aria-label="Repeat end date"
              value={untilDate}
              onChange={(event) => setUntilDate(event.target.value)}
            />
          </label>
        ) : null}
        {task.recurrence ? (
          <label className="block text-sm">
            Apply changes to
            <select
              id="task-apply-scope"
              className="mt-1 h-10 w-full rounded-lg border border-line bg-surface px-2"
              aria-label="Apply changes to"
              value={scope}
              onChange={(event) => setScope(event.target.value as "this" | "following")}
            >
              <option value="this">This date</option>
              <option value="following">This and future dates</option>
            </select>
            <span className="mt-1 block text-xs text-muted">
              {task.occurrenceOriginalDueAt
                ? "This date already differs from the series. Completing it returns to the repeat rule."
                : "This date can have its own title, priority, reminder, or due time. Repeat, list, tags, start date, and estimate stay with the series."}
            </span>
          </label>
        ) : null}
        {frequency === "weekly" ? (
          <div className="flex flex-wrap gap-2 text-sm">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((label, index) => {
              const day = index + 1;
              return (
                <label key={label} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={weekdays.includes(day)}
                    onChange={() => setWeekdays((current) => (current.includes(day) ? current.filter((item) => item !== day) : [...current, day]))}
                  />
                  {label}
                </label>
              );
            })}
          </div>
        ) : null}
        <div>
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium">
              Subtasks
              {task.subtaskCount ? ` · ${task.openSubtaskCount ?? 0} of ${task.subtaskCount} open` : ""}
            </h3>
            {task.status !== "archived" && (task.openSubtaskCount ?? 0) > 0 ? (
              <button
                id="task-complete-open-subtasks"
                type="button"
                className="text-xs text-muted disabled:opacity-50"
                disabled={!online}
                onClick={() => {
                  const focusCompleteOpen = () =>
                    focusTaskDetailQuery(
                      "#task-complete-open-subtasks",
                      "#task-subtask",
                      '[aria-label="New subtask"]',
                      "#task-save",
                    );
                  const parentId = task.id;
                  const openIds = (detail.data?.subtasks ?? []).filter((item) => item.status === "open").map((item) => item.id);
                  if (openIds.length === 0) {
                    toast.push("Those subtasks are already completed.");
                    focusCompleteOpen();
                    return;
                  }
                  void (async () => {
                    if (!online) {
                      toast.push("You are offline. Reconnect to complete open subtasks.");
                      focusCompleteOpen();
                      return;
                    }
                    try {
                      await api.finishSubtasks(parentId);
                      await refresh();
                      const count = openIds.length;
                      const main = count === 1 ? "Open subtask completed." : "Open subtasks completed.";
                      toast.push(main, {
                        label: "Undo",
                        run: () => {
                          if (!navigator.onLine) {
                            toast.push("You are offline. Reconnect to reopen those subtasks.");
                            focusCompleteOpen();
                            return;
                          }
                          void (async () => {
                            try {
                              let brought = 0;
                              for (const id of openIds) {
                                await api.uncompleteTask(id);
                                brought += 1;
                              }
                              toast.push(
                                brought === 0
                                  ? "Those subtasks are already open."
                                  : brought === 1
                                    ? "Reopened 1 subtask."
                                    : `Reopened ${brought} subtasks.`,
                              );
                              focusCompleteOpen();
                              await refresh();
                            } catch (error: unknown) {
                              void refresh();
                              toast.push(error instanceof ApiError ? error.message : "Could not reopen those subtasks.");
                              focusCompleteOpen();
                            }
                          })();
                        },
                      });
                      focusCompleteOpen();
                    } catch (error) {
                      toast.push(error instanceof ApiError ? error.message : "Could not complete open subtasks.");
                      focusCompleteOpen();
                    }
                  })();
                }}
              >
                Complete open subtasks
              </button>
            ) : null}
          </div>
          <ul className="mt-2 space-y-1">
            {(detail.data?.subtasks ?? []).map((item, index, items) => (
              <li key={item.id} className="flex items-center gap-2 text-sm">
                {item.status === "archived" ? (
                  <button
                    type="button"
                    className="text-xs text-muted disabled:opacity-50"
                    data-subtask-action={`unarchive-${item.id}`}
                    aria-label={`Unarchive ${item.title}`}
                    disabled={!online}
                    onClick={() => {
                      const subtaskId = item.id;
                      const focusUnarchive = () =>
                        focusTaskDetailQuery(
                          `[data-subtask-action="unarchive-${subtaskId}"]`,
                          `[data-subtask-action="archive-${subtaskId}"]`,
                          `[aria-label="Open ${item.title}"]`,
                          "#task-subtask",
                          "#task-save",
                        );
                      if (!online) {
                        toast.push("You are offline. Reconnect to unarchive that subtask.");
                        focusUnarchive();
                        return;
                      }
                      void api
                        .unarchiveTask(subtaskId)
                        .then(() => refresh())
                        .then(() => {
                          toast.push("Subtask unarchived.", {
                            label: "Undo",
                            run: () => {
                              if (!navigator.onLine) {
                                toast.push("You are offline. Reconnect to archive that subtask.");
                                focusUnarchive();
                                return;
                              }
                              void api
                                .archiveTask(subtaskId)
                                .then(() => refresh())
                                .then(() => {
                                  toast.push("Subtask archived.");
                                  focusUnarchive();
                                })
                                .catch((error: unknown) => {
                                  void refresh();
                                  toast.push(error instanceof ApiError ? error.message : "Could not archive the subtask.");
                                  focusUnarchive();
                                });
                            },
                          });
                          focusUnarchive();
                        })
                        .catch((error: unknown) => {
                          toast.push(error instanceof ApiError ? error.message : "Could not unarchive the subtask.");
                          focusUnarchive();
                        });
                    }}
                  >
                    Unarchive
                  </button>
                ) : (
                  <input
                    id={`subtask-check-${item.id}`}
                    type="checkbox"
                    checked={item.status === "completed"}
                    aria-label={`${item.status === "completed" ? "Mark open" : "Complete"} ${item.title}`}
                    disabled={!online}
                    onChange={() => {
                      const reopen = item.status === "completed";
                      void run(
                        () => (reopen ? api.uncompleteTask(item.id) : api.completeTask(item.id)),
                        reopen ? "Subtask reopened." : "Subtask completed.",
                        `subtask-check-${item.id}`,
                        reopen
                          ? "You are offline. Reconnect to reopen that subtask."
                          : "You are offline. Reconnect to complete that subtask.",
                        reopen ? "Could not reopen the subtask." : "Could not complete the subtask.",
                      );
                    }}
                  />
                )}
                <button type="button" className={`min-w-0 flex-1 truncate text-left ${item.status === "completed" ? "text-muted line-through" : item.status === "archived" ? "text-muted" : ""}`} aria-label={`Open ${item.title}`} onClick={() => onOpen(item.id)}>
                  {item.title}
                  {item.status === "archived" ? <span className="ml-2 text-xs font-normal">Archived</span> : null}
                  {item.dueAt ? (
                    <span className={`ml-2 text-xs font-normal ${isOverdue(item.dueAt, item.timeZone, new Date().toISOString()) ? "text-danger" : "text-muted"}`}>
                      {formatDueLabel(item.dueAt, item.timeZone, new Date().toISOString(), item.dueHasTime)}
                      {isOverdue(item.dueAt, item.timeZone, new Date().toISOString()) ? " · Overdue" : ""}
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  className="text-xs text-muted disabled:opacity-50"
                  data-subtask-action={`up-${item.id}`}
                  aria-label={`Move ${item.title} up`}
                  disabled={!online || index === 0}
                  onClick={() => void moveSubtask(index, -1)}
                >
                  Up
                </button>
                <button
                  type="button"
                  className="text-xs text-muted disabled:opacity-50"
                  data-subtask-action={`down-${item.id}`}
                  aria-label={`Move ${item.title} down`}
                  disabled={!online || index === items.length - 1}
                  onClick={() => void moveSubtask(index, 1)}
                >
                  Down
                </button>
                <button
                  type="button"
                  className="text-xs text-muted disabled:opacity-50"
                  data-subtask-action={`duplicate-${item.id}`}
                  aria-label={`Duplicate ${item.title}`}
                  disabled={!online}
                  onClick={() => {
                    const subtaskId = item.id;
                    const focusDuplicate = () =>
                      focusTaskDetailQuery(
                        `[data-subtask-action="duplicate-${subtaskId}"]`,
                        "#task-subtask",
                        "#task-save",
                      );
                    void (async () => {
                      if (!online) {
                        toast.push("You are offline. Reconnect to duplicate that subtask.");
                        focusDuplicate();
                        return;
                      }
                      try {
                        const copy = await api.duplicateTask(subtaskId);
                        await refresh();
                        const copyId = copy.id;
                        toast.push("Subtask duplicated.", {
                          label: "Undo",
                          run: () => {
                            if (!navigator.onLine) {
                              toast.push("You are offline. Reconnect to remove that copy.");
                              focusDuplicate();
                              return;
                            }
                            void api
                              .deleteTask(copyId)
                              .then(() => refresh())
                              .then(() => {
                                toast.push("Removed the duplicate.");
                                focusDuplicate();
                              })
                              .catch((error: unknown) => {
                                void refresh();
                                toast.push(error instanceof ApiError ? error.message : "Could not remove the duplicate.");
                                focusDuplicate();
                              });
                          },
                        });
                        focusDuplicate();
                      } catch (error) {
                        toast.push(error instanceof ApiError ? error.message : "Could not duplicate the subtask.");
                        focusDuplicate();
                      }
                    })();
                  }}
                >
                  Duplicate
                </button>
                {item.status !== "archived" ? (
                  <button
                    type="button"
                    className="text-xs text-muted disabled:opacity-50"
                    data-subtask-action={`archive-${item.id}`}
                    aria-label={`Archive ${item.title}`}
                    disabled={!online}
                    onClick={() => {
                      const subtaskId = item.id;
                      const focusArchive = () =>
                        focusTaskDetailQuery(
                          `[data-subtask-action="archive-${subtaskId}"]`,
                          `[data-subtask-action="unarchive-${subtaskId}"]`,
                          `[aria-label="Open ${item.title}"]`,
                          "#task-subtask",
                          "#task-save",
                        );
                      if (!online) {
                        toast.push("You are offline. Reconnect to archive that subtask.");
                        focusArchive();
                        return;
                      }
                      void api
                        .archiveTask(subtaskId)
                        .then(() => refresh())
                        .then(() => {
                          toast.push("Subtask archived.", {
                            label: "Undo",
                            run: () => {
                              if (!navigator.onLine) {
                                toast.push("You are offline. Reconnect to unarchive that subtask.");
                                focusArchive();
                                return;
                              }
                              void api
                                .unarchiveTask(subtaskId)
                                .then(() => refresh())
                                .then(() => {
                                  toast.push("Subtask unarchived.");
                                  focusArchive();
                                })
                                .catch((error: unknown) => {
                                  void refresh();
                                  toast.push(error instanceof ApiError ? error.message : "Could not unarchive the subtask.");
                                  focusArchive();
                                });
                            },
                          });
                          focusArchive();
                        })
                        .catch((error: unknown) => {
                          toast.push(error instanceof ApiError ? error.message : "Could not archive the subtask.");
                          focusArchive();
                        });
                    }}
                  >
                    Archive
                  </button>
                ) : null}
                <button
                  type="button"
                  className="text-xs text-danger"
                  data-subtask-action={`delete-${item.id}`}
                  aria-label={`Delete ${item.title}`}
                  onClick={() => {
                    const subtaskId = item.id;
                    const focusDelete = () =>
                      focusTaskDetailQuery(
                        `[data-subtask-action="delete-${subtaskId}"]`,
                        "#task-subtask",
                        '[aria-label="New subtask"]',
                        "#task-save",
                      );
                    void sync
                      .deleteTask(item)
                      .then((result) => {
                        if (result === "queued") {
                          toast.push("Saved on this device. It will sync when you reconnect.");
                          focusDelete();
                          return;
                        }
                        void refresh();
                        toast.push("Subtask deleted.", {
                          label: "Undo",
                          run: () => {
                            void sync
                              .restoreTask(item)
                              .then((restored) => {
                                void refresh();
                                toast.push(restored === "queued" ? "Saved on this device. It will sync when you reconnect." : "Subtask restored.");
                                focusDelete();
                              })
                              .catch((error: unknown) => {
                                void refresh();
                                toast.push(error instanceof ApiError ? error.message : "Could not restore the subtask.");
                                focusDelete();
                              });
                          },
                        });
                      })
                      .catch((error: unknown) => {
                        toast.push(error instanceof ApiError ? error.message : "Could not delete the subtask.");
                        focusDelete();
                      });
                  }}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
          {task.status === "open" ? (
            <form
              className="mt-2 flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const focusNewSubtask = () => focusTaskDetailIds("task-subtask", "task-save");
                const title = subtask.trim();
                if (!title) {
                  focusNewSubtask();
                  return;
                }
                if (!online) {
                  toast.push("You are offline. Reconnect to add a subtask.");
                  focusNewSubtask();
                  return;
                }
                const parentId = task.id;
                const listId = task.listId;
                void (async () => {
                  try {
                    const created = await api.createTask({ title, parentId, listId }, crypto.randomUUID());
                    setSubtask("");
                    await refresh();
                    const createdId = created.id;
                    toast.push("Subtask added.", {
                      label: "Undo",
                      run: () => {
                        if (!navigator.onLine) {
                          toast.push("You are offline. Reconnect to remove that subtask.");
                          focusNewSubtask();
                          return;
                        }
                        void api
                          .deleteTask(createdId)
                          .then(() => refresh())
                          .then(() => {
                            toast.push("Removed the subtask.");
                            focusNewSubtask();
                          })
                          .catch((error: unknown) => {
                            void refresh();
                            toast.push(error instanceof ApiError ? error.message : "Could not delete the subtask.");
                            focusNewSubtask();
                          });
                      },
                    });
                    focusNewSubtask();
                  } catch (error) {
                    toast.push(error instanceof ApiError ? error.message : "Could not add the subtask.");
                    focusNewSubtask();
                  }
                })();
              }}
            >
              <Input id="task-subtask" aria-label="New subtask" value={subtask} onChange={(event) => setSubtask(event.target.value)} placeholder="Add a subtask" disabled={!online} />
              <Button type="submit" variant="secondary" disabled={!online}>
                Add
              </Button>
            </form>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap gap-2 border-t border-line p-4">
        <Button id="task-save" type="button" aria-label="Save task" onClick={() => void save()}>
          Save
        </Button>
        {task.recurrence ? (
          <Button
            id="task-skip"
            type="button"
            variant="secondary"
            disabled={!online}
            onClick={() => {
              const focusSkip = () =>
                focusTaskDetailIds("task-skip", "task-save");
              const taskIdToSkip = task.id;
              void (async () => {
                if (!online) {
                  toast.push("You are offline. Reconnect to skip this occurrence.");
                  focusSkip();
                  return;
                }
                try {
                  await api.skipTask(taskIdToSkip);
                  await refresh();
                  toast.push("Occurrence skipped.", {
                    label: "Undo",
                    run: () => {
                      if (!navigator.onLine) {
                        toast.push("You are offline. Reconnect to restore the skipped date.");
                        focusSkip();
                        return;
                      }
                      void api
                        .uncompleteTask(taskIdToSkip)
                        .then(() => refresh())
                        .then(() => {
                          toast.push("Restored the skipped date.");
                          focusSkip();
                        })
                        .catch((error: unknown) => {
                          void refresh();
                          toast.push(error instanceof ApiError ? error.message : "Could not restore the skipped date.");
                          focusSkip();
                        });
                    },
                  });
                  focusSkip();
                } catch (error) {
                  toast.push(error instanceof ApiError ? error.message : "Could not skip this occurrence.");
                  focusSkip();
                }
              })();
            }}
          >
            Skip
          </Button>
        ) : null}
        {task.recurrence ? (
          <Button
            id="task-omit"
            type="button"
            variant="secondary"
            disabled={!online}
            onClick={() => {
              const focusOmit = () =>
                focusTaskDetailIds("task-omit", "task-save");
              const taskIdToOmit = task.id;
              void (async () => {
                if (!online) {
                  toast.push("You are offline. Reconnect to remove this date.");
                  focusOmit();
                  return;
                }
                try {
                  const result = await api.omitOccurrence(taskIdToOmit);
                  await refresh();
                  const finished = result.status === "completed" && !result.recurrence;
                  toast.push(
                    finished ? "This date was removed. The series is finished." : "This date was removed. The series continues.",
                    {
                      label: "Undo",
                      run: () => {
                        if (!navigator.onLine) {
                          toast.push("You are offline. Reconnect to restore this date.");
                          focusOmit();
                          return;
                        }
                        void api
                          .restoreOmittedOccurrence(taskIdToOmit)
                          .then(() => refresh())
                          .then(() => {
                            toast.push("Restored the removed date.");
                            focusOmit();
                          })
                          .catch((error: unknown) => {
                            void refresh();
                            toast.push(error instanceof ApiError ? error.message : "Could not restore the removed date.");
                            focusOmit();
                          });
                      },
                    },
                  );
                  focusOmit();
                } catch (error) {
                  toast.push(error instanceof ApiError ? error.message : "Could not remove this date.");
                  focusOmit();
                }
              })();
            }}
          >
            Remove this date
          </Button>
        ) : null}
        {task.status === "completed" || (task.recurrence && task.status === "open") ? (
          <Button
            id="task-reopen"
            type="button"
            variant="secondary"
            onClick={() => {
              const focusReopen = () =>
                focusTaskDetailIds("task-reopen", "task-save");
              const taskIdToReopen = task.id;
              void sync
                .reopenTask(task)
                .then((result) => {
                  void refresh();
                  if (result === "queued") {
                    toast.push("Saved on this device. It will sync when you reconnect.");
                    focusReopen();
                    return;
                  }
                  toast.push("Task reopened.", {
                    label: "Undo",
                    run: () => {
                      if (!navigator.onLine) {
                        toast.push("You are offline. Reconnect to complete that task.");
                        focusReopen();
                        return;
                      }
                      void api
                        .completeTask(taskIdToReopen)
                        .then(() => refresh())
                        .then(() => {
                          toast.push("Task completed.");
                          focusReopen();
                        })
                        .catch((error: unknown) => {
                          void refresh();
                          toast.push(error instanceof ApiError ? error.message : "Could not complete the task.");
                          focusReopen();
                        });
                    },
                  });
                  focusReopen();
                })
                .catch((error: unknown) => {
                  toast.push(error instanceof ApiError ? error.message : "Could not reopen the task.");
                  focusReopen();
                });
            }}
          >
            Reopen
          </Button>
        ) : null}
        <Button
          id="task-archive"
          type="button"
          variant="secondary"
          disabled={!online}
          onClick={() => {
            const focusArchive = () =>
              focusTaskDetailIds("task-archive", "task-save");
            if (!online) {
              toast.push(
                task.status !== "archived"
                  ? "You are offline. Reconnect to archive that task."
                  : "You are offline. Reconnect to unarchive that task.",
              );
              focusArchive();
              return;
            }
            const archiving = task.status !== "archived";
            const subtasks = detail.data?.subtasks ?? [];
            const archivedCount = subtasks.filter((item) => item.status === "archived").length;
            const activeCount = subtasks.filter((item) => item.status !== "archived").length;
            const message = archiving
              ? activeCount === 1
                ? "Task archived. Its subtask was archived too."
                : activeCount > 1
                  ? "Task archived. Its subtasks were archived too."
                  : "Task archived."
              : archivedCount === 1
                ? "Task unarchived. Its subtask was restored too."
                : archivedCount > 1
                  ? "Task unarchived. Its subtasks were restored too."
                  : "Task unarchived.";
            const taskIdToToggle = task.id;
            void (archiving ? api.archiveTask(taskIdToToggle) : api.unarchiveTask(taskIdToToggle))
              .then(() => refresh())
              .then(() => {
                toast.push(message, {
                  label: "Undo",
                  run: () => {
                    if (!navigator.onLine) {
                      toast.push(
                        archiving
                          ? "You are offline. Reconnect to unarchive that task."
                          : "You are offline. Reconnect to archive that task.",
                      );
                      focusArchive();
                      return;
                    }
                    void (archiving ? api.unarchiveTask(taskIdToToggle) : api.archiveTask(taskIdToToggle))
                      .then(() => refresh())
                      .then(() => {
                        toast.push(archiving ? "Task unarchived." : "Task archived.");
                        focusArchive();
                      })
                      .catch((error: unknown) => {
                        void refresh();
                        toast.push(
                          error instanceof ApiError
                            ? error.message
                            : archiving
                              ? "Could not unarchive the task."
                              : "Could not archive the task.",
                        );
                        focusArchive();
                      });
                  },
                });
                focusArchive();
              })
              .catch((error: unknown) => {
                toast.push(
                  error instanceof ApiError
                    ? error.message
                    : archiving
                      ? "Could not archive the task."
                      : "Could not unarchive the task.",
                );
                focusArchive();
              });
          }}
        >
          {task.status === "archived" ? "Unarchive" : "Archive"}
        </Button>
        <Button
          id="task-duplicate"
          type="button"
          variant="secondary"
          disabled={!online}
          onClick={() => {
            const focusDuplicate = () =>
              focusTaskDetailIds("task-duplicate", "task-save");
            const sourceId = task.id;
            void (async () => {
              if (!online) {
                toast.push("You are offline. Reconnect to duplicate that task.");
                focusDuplicate();
                return;
              }
              try {
                const copy = await api.duplicateTask(sourceId);
                await refresh();
                const copyId = copy.id;
                const subtasks = copy.subtaskCount ?? 0;
                const extra =
                  subtasks === 0 ? "" : subtasks === 1 ? " Its subtask was copied too." : " Its subtasks were copied too.";
                toast.push(`Task duplicated.${extra}`, {
                  label: "Undo",
                  run: () => {
                    if (!navigator.onLine) {
                      toast.push("You are offline. Reconnect to remove that copy.");
                      focusDuplicate();
                      return;
                    }
                    void api
                      .deleteTask(copyId)
                      .then(() => refresh())
                      .then(() => {
                        toast.push("Removed the duplicate.");
                        focusDuplicate();
                      })
                      .catch((error: unknown) => {
                        void refresh();
                        toast.push(error instanceof ApiError ? error.message : "Could not remove the duplicate.");
                        focusDuplicate();
                      });
                  },
                });
                focusDuplicate();
              } catch (error) {
                toast.push(error instanceof ApiError ? error.message : "Could not duplicate the task.");
                focusDuplicate();
              }
            })();
          }}
        >
          Duplicate
        </Button>
        <Button
          id="task-delete"
          type="button"
          variant="danger"
          onClick={() => {
            const focusDelete = () => focusTaskDetailIds("task-delete", "quick-add", "task-save", "workspace-heading");
            void sync
              .deleteTask(task)
              .then((result) => {
                if (result === "queued") {
                  toast.push("Saved on this device. It will sync when you reconnect.");
                  focusDelete();
                  return;
                }
                onClose();
                void refresh();
                const subtasks = (detail.data?.subtasks ?? []).length;
                const extra = subtasks === 1 ? " Its subtask was deleted too." : subtasks > 1 ? " Its subtasks were deleted too." : "";
                toast.push(`Task deleted.${extra}`, {
                  label: "Undo",
                  run: () => {
                    void sync
                      .restoreTask(task)
                      .then((restored) => {
                        void refresh();
                        toast.push(restored === "queued" ? "Saved on this device. It will sync when you reconnect." : "Task restored.");
                        focusDelete();
                      })
                      .catch((error: unknown) => {
                        void refresh();
                        toast.push(error instanceof ApiError ? error.message : "Could not restore the task.");
                        focusDelete();
                      });
                  },
                });
              })
              .catch((error: unknown) => {
                toast.push(error instanceof ApiError ? error.message : "Could not delete the task.");
                focusDelete();
              });
          }}
        >
          Delete
        </Button>
      </div>
    </div>
  );
}
