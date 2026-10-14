"use client";

import { ApiError } from "@vela/api-client";
import type { ListDto, Priority, TagDto } from "@vela/shared";
import { combineDateAndTime, splitDue } from "@vela/shared";
import { Button, Input, Textarea } from "@vela/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useOnline, useToast } from "@/components/providers";
import { api } from "@/lib/api";

const reminders = [
  ["", "No reminder"],
  ["0", "At the due time"],
  ["15", "15 minutes before"],
  ["60", "1 hour before"],
  ["1440", "1 day before"],
] as const;

export function TaskDetail({ taskId, lists, tags, onClose }: { taskId: string; lists: ListDto[]; tags: TagDto[]; onClose: () => void }) {
  const online = useOnline();
  const toast = useToast();
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ["task", taskId], queryFn: () => api.getTask(taskId) });
  const task = detail.data?.task;
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
  }, [task]);

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["tasks"] });
    await queryClient.invalidateQueries({ queryKey: ["task", taskId] });
  }

  async function save() {
    if (!task) return;
    if (!online) {
      toast.push("You are offline. Reconnect to save changes.");
      return;
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
      await api.updateTask(task.id, {
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
        recurrence: frequency
          ? {
              frequency,
              interval: Number(interval) || 1,
              ...(frequency === "weekly" && weekdays.length > 0 ? { byWeekday: weekdays } : {}),
              ...(count ? { count: Number(count) } : {}),
            }
          : null,
        revision: task.revision,
      });
      await refresh();
      toast.push("Task saved.");
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not save the task.");
    }
  }

  async function run(action: () => Promise<unknown>, message: string) {
    if (!online) {
      toast.push("You are offline. Reconnect to save changes.");
      return;
    }
    try {
      await action();
      await refresh();
      toast.push(message);
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not update the task.");
    }
  }

  if (detail.isLoading || !task) {
    return <div className="p-4 text-sm text-muted">Loading task…</div>;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="font-medium">Task details</h2>
        <button type="button" className="text-sm text-muted" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        <Input aria-label="Title" value={title} onChange={(event) => setTitle(event.target.value)} />
        <Textarea aria-label="Description" value={description} onChange={(event) => setDescription(event.target.value)} />
        <label className="block text-sm">
          List
          <select className="mt-1 h-10 w-full rounded-lg border border-line bg-surface px-2" value={listId} onChange={(event) => setListId(event.target.value)}>
            {lists.map((list) => (
              <option key={list.id} value={list.id}>
                {list.name}
              </option>
            ))}
          </select>
        </label>
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
            {tags.map((tag) => (
              <label key={tag.id} className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  checked={tagIds.includes(tag.id)}
                  onChange={() => setTagIds((current) => (current.includes(tag.id) ? current.filter((id) => id !== tag.id) : [...current, tag.id]))}
                />
                {tag.name}
              </label>
            ))}
            {tags.length === 0 ? <span className="text-sm text-muted">No tags yet.</span> : null}
          </div>
        </fieldset>
        <label className="block text-sm">
          Estimated minutes
          <Input className="mt-1" inputMode="numeric" value={estimated} onChange={(event) => setEstimated(event.target.value)} />
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
          <span className="mt-1 block text-xs text-muted">Saved on the server. Delivery is an in-app notice while this tab is open.</span>
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
              <Input className="mt-1" inputMode="numeric" value={interval} onChange={(event) => setIntervalValue(event.target.value)} />
            </label>
            <label className="text-sm">
              Occurrences
              <Input className="mt-1" inputMode="numeric" value={count} placeholder="Unlimited" onChange={(event) => setCount(event.target.value)} />
            </label>
          </div>
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
          <h3 className="text-sm font-medium">Subtasks</h3>
          <ul className="mt-2 space-y-1">
            {(detail.data?.subtasks ?? []).map((item) => (
              <li key={item.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={item.status === "completed"}
                  aria-label={`Complete ${item.title}`}
                  onChange={() =>
                    void run(
                      () => (item.status === "completed" ? api.uncompleteTask(item.id) : api.completeTask(item.id)),
                      "Subtask updated.",
                    )
                  }
                />
                {item.title}
              </li>
            ))}
          </ul>
          <form
            className="mt-2 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!subtask.trim()) return;
              void run(async () => {
                await api.createTask({ title: subtask.trim(), parentId: task.id, listId: task.listId }, crypto.randomUUID());
                setSubtask("");
              }, "Subtask added.");
            }}
          >
            <Input aria-label="New subtask" value={subtask} onChange={(event) => setSubtask(event.target.value)} placeholder="Add a subtask" />
            <Button type="submit" variant="secondary">
              Add
            </Button>
          </form>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 border-t border-line p-4">
        <Button type="button" onClick={() => void save()}>
          Save
        </Button>
        {task.recurrence ? (
          <Button type="button" variant="secondary" onClick={() => void run(() => api.skipTask(task.id), "Occurrence skipped.")}>
            Skip
          </Button>
        ) : null}
        <Button type="button" variant="secondary" onClick={() => void run(() => api.uncompleteTask(task.id), "Task reopened.")}>
          Reopen
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() =>
            void run(
              () => (task.status === "archived" ? api.unarchiveTask(task.id) : api.archiveTask(task.id)),
              task.status === "archived" ? "Task unarchived." : "Task archived.",
            )
          }
        >
          {task.status === "archived" ? "Unarchive" : "Archive"}
        </Button>
        <Button
          type="button"
          variant="danger"
          onClick={() =>
            void run(async () => {
              await api.deleteTask(task.id);
              onClose();
              toast.push("Task deleted.", {
                label: "Undo",
                run: () => {
                  void api.restoreTask(task.id).then(() => refresh());
                },
              });
            }, "Task deleted.")
          }
        >
          Delete
        </Button>
      </div>
    </div>
  );
}
