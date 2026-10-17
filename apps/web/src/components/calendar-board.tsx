"use client";

import { ApiError } from "@vela/api-client";
import type { TaskDto } from "@vela/shared";
import { combineDateAndTime } from "@vela/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DateTime } from "luxon";
import { useEffect, useMemo, useState } from "react";
import { useOnline, useToast } from "@/components/providers";
import { api } from "@/lib/api";

type Mode = "month" | "week" | "day";

export function CalendarBoard({ timeZone, onOpen }: { timeZone: string; onOpen: (id: string) => void }) {
  const [cursor, setCursor] = useState<DateTime>(() => DateTime.now().setZone(timeZone).startOf("day"));
  const [mode, setMode] = useState<Mode>("month");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const online = useOnline();
  const toast = useToast();
  const queryClient = useQueryClient();
  const range = useMemo(() => visibleRange(cursor, mode), [cursor, mode]);
  const tasks = useQuery({
    queryKey: ["tasks", "calendar", range.from, range.to],
    queryFn: () => api.listTasks({ view: "calendar", from: range.from, to: range.to }),
  });
  const selectedTask = (tasks.data?.tasks ?? []).find((task) => task.id === selectedId) ?? null;

  function clearSelection() {
    const id = selectedId;
    setSelectedId(null);
    if (!id) return;
    queueMicrotask(() => {
      const chip = document.querySelector<HTMLElement>(`[data-calendar-task="${id}"]`);
      if (chip) chip.focus();
      else document.getElementById("workspace-heading")?.focus();
    });
  }

  useEffect(() => {
    if (!selectedId || !tasks.data) return;
    if (tasks.data.tasks.some((task) => task.id === selectedId)) return;
    const active = document.activeElement;
    const restore =
      active instanceof HTMLElement &&
      (active.getAttribute("aria-label") === "Clear calendar selection" ||
        active.getAttribute("data-calendar-task") === selectedId);
    setSelectedId(null);
    if (restore) {
      queueMicrotask(() => document.getElementById("workspace-heading")?.focus());
    }
  }, [selectedId, tasks.data]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (typing) return;
      if (event.key === "Escape" && selectedId) {
        if (event.defaultPrevented) return;
        if (document.querySelector('[role="dialog"]')) return;
        event.preventDefault();
        clearSelection();
        return;
      }
      if (event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setCursor((current) => shift(current, mode, -1));
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        setCursor((current) => shift(current, mode, 1));
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "m") {
        event.preventDefault();
        setMode("month");
        return;
      }
      if (key === "w") {
        event.preventDefault();
        setMode("week");
        return;
      }
      if (key === "d") {
        event.preventDefault();
        setMode("day");
        return;
      }
      if (key === "t") {
        event.preventDefault();
        setCursor(DateTime.now().setZone(timeZone).startOf("day"));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [selectedId, mode, timeZone]);

  async function reschedule(day: DateTime) {
    const dayId = `calendar-day-${day.toFormat("yyyy-MM-dd")}`;
    const focusTaskId = selectedId;
    const focusDay = () =>
      queueMicrotask(() => {
        const dayCell = document.getElementById(dayId);
        if (dayCell instanceof HTMLButtonElement && !dayCell.disabled) {
          dayCell.focus();
          return;
        }
        const chip = focusTaskId
          ? document.querySelector<HTMLElement>(`[data-calendar-task="${focusTaskId}"]`)
          : null;
        if (
          chip &&
          (!(chip instanceof HTMLButtonElement) || !chip.disabled) &&
          (!(chip instanceof HTMLInputElement) || !chip.disabled)
        ) {
          chip.focus();
          return;
        }
        document.getElementById("workspace-heading")?.focus();
      });
    const task = (tasks.data?.tasks ?? []).find((item) => item.id === selectedId);
    if (!task) {
      toast.push("Select a task, then choose a day.");
      focusDay();
      return;
    }
    if (!online) {
      toast.push("You are offline. Reconnect to move that task.");
      focusDay();
      return;
    }
    if (sameDay(task, day, timeZone)) {
      toast.push("That task is already on that day.");
      focusDay();
      return;
    }
    const previousDueAt = task.dueAt;
    const previousDueHasTime = task.dueHasTime;
    const previousRevisionScope = task.recurrence ? ("this" as const) : undefined;
    const time = task.dueAt && task.dueHasTime ? DateTime.fromISO(task.dueAt, { zone: "utc" }).setZone(timeZone).toFormat("HH:mm") : null;
    try {
      const next = combineDateAndTime(day.toFormat("yyyy-MM-dd"), time, timeZone);
      const savedTaskId = task.id;
      await api.updateTask(task.id, {
        dueAt: next.dueAt,
        dueHasTime: next.dueHasTime,
        revision: task.revision,
        ...(task.recurrence ? { occurrenceScope: "this" } : {}),
      });
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      const message = task.recurrence
        ? `Moved this date of “${task.title}” to ${day.toFormat("LLL d")}. The rest of the series stays put.`
        : `Moved “${task.title}” to ${day.toFormat("LLL d")}.`;
      toast.push(message, {
        label: "Undo",
        run: () => {
          if (!navigator.onLine) {
            toast.push("You are offline. Reconnect to restore the date.");
            focusDay();
            return;
          }
          void api
            .getTask(savedTaskId)
            .then((detail) =>
              api.updateTask(savedTaskId, {
                dueAt: previousDueAt,
                dueHasTime: previousDueHasTime,
                revision: detail.task.revision,
                ...(previousRevisionScope ? { occurrenceScope: previousRevisionScope } : {}),
              }),
            )
            .then(async () => {
              await queryClient.invalidateQueries({ queryKey: ["tasks"] });
              toast.push("Restored the date.");
              focusDay();
            })
            .catch((error: unknown) => {
              void queryClient.invalidateQueries({ queryKey: ["tasks"] });
              toast.push(error instanceof ApiError ? error.message : "Could not restore the date.");
              focusDay();
            });
        },
      });
      focusDay();
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not reschedule the task.");
      focusDay();
    }
  }

  const days = range.days;
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button className="rounded-lg border border-line px-3 py-1 text-sm" type="button" onClick={() => setCursor(shift(cursor, mode, -1))}>
          Previous
        </button>
        <button className="rounded-lg border border-line px-3 py-1 text-sm" type="button" onClick={() => setCursor(DateTime.now().setZone(timeZone).startOf("day"))}>
          Today
        </button>
        <button className="rounded-lg border border-line px-3 py-1 text-sm" type="button" onClick={() => setCursor(shift(cursor, mode, 1))}>
          Next
        </button>
        <p className="px-2 font-medium">{cursor.toFormat(mode === "day" ? "DDDD" : "LLLL yyyy")}</p>
        {(["month", "week", "day"] as const).map((item) => (
          <button
            key={item}
            className={`rounded-lg px-3 py-1 text-sm capitalize ${mode === item ? "bg-accent text-accent-ink" : "border border-line"}`}
            type="button"
            aria-pressed={mode === item}
            onClick={() => setMode(item)}
          >
            {item}
          </button>
        ))}
      </div>
      <p className="mb-3 text-sm text-muted">
        {!online ? (
          <>You are offline. Reconnect to move a task on the calendar. </>
        ) : null}
        {selectedTask ? (
          <>
            Selected “{selectedTask.title}”. Choose a day to move it, or{" "}
            <button className="text-accent" type="button" aria-label="Clear calendar selection" onClick={clearSelection}>
              clear the selection
            </button>
            . Escape also clears it. Undo restores the previous date.
          </>
        ) : (
          <>
            Select a task, then choose another day to reschedule it. Undo restores the previous date. The time of day stays the same when one is set. A repeating
            task moves only that date. Choosing the day it already has leaves it as it is. Arrow Left and Arrow Right move the period. Press M, W, or D for month, week, or day. Press T for today.
          </>
        )}
      </p>
      {tasks.isLoading ? (
        <p className="mb-3 text-sm text-muted" role="status">
          Loading calendar…
        </p>
      ) : null}
      {tasks.isError ? (
        <div className="mb-3 text-sm">
          <p>Calendar tasks could not be loaded.</p>
          <button className="mt-2 text-accent" type="button" aria-label="Calendar tasks could not be loaded. Try again" onClick={() => void tasks.refetch()}>
            Try again
          </button>
        </div>
      ) : null}
      {tasks.data && (tasks.data.tasks ?? []).length === 0 ? (
        <p className="mb-3 text-sm text-muted" role="status">
          No dated tasks in this period.
        </p>
      ) : null}
      <div className={mode === "month" ? "grid grid-cols-7 gap-1" : "grid gap-2"}>
        {mode === "month"
          ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((label) => (
              <div key={label} className="px-1 text-xs text-muted">
                {label}
              </div>
            ))
          : null}
        {days.map((day) => {
          const items = (tasks.data?.tasks ?? []).filter((task) => sameDay(task, day, timeZone));
          const visible = mode === "month" ? items.slice(0, 4) : items;
          const hidden = items.length - visible.length;
          return (
            <div
              key={day.toISODate()}
              className={`min-h-24 rounded-2xl border border-line bg-surface p-2 text-left shadow-sm ${day.hasSame(cursor, "month") || mode !== "month" ? "" : "opacity-50"}`}
            >
              <button
                id={`calendar-day-${day.toFormat("yyyy-MM-dd")}`}
                className="text-xs text-muted disabled:opacity-50"
                type="button"
                disabled={!online}
                aria-label={
                  !online
                    ? `You are offline. Reconnect to move a task to ${day.toFormat("LLLL d")}`
                    : selectedId
                      ? `Move the selected task to ${day.toFormat("LLLL d")}`
                      : `Select a task, then choose ${day.toFormat("LLLL d")}`
                }
                onClick={() => void reschedule(day)}
              >
                {day.toFormat("d")}
              </button>
              <ul className="mt-1 space-y-1">
                {visible.map((task) => (
                  <li key={task.id}>
                    <button
                      className={`block w-full truncate rounded px-1 text-left text-xs ${selectedId === task.id ? "bg-accent text-accent-ink" : task.status === "completed" ? "bg-sidebar text-muted line-through" : "bg-sidebar"}`}
                      type="button"
                      data-calendar-task={task.id}
                      aria-pressed={selectedId === task.id}
                      aria-label={`${task.status === "completed" ? "Finished " : ""}${task.title}${task.parentTitle ? `, subtask of ${task.parentTitle}` : ""}`}
                      onClick={() => {
                        setSelectedId(task.id);
                        onOpen(task.id);
                      }}
                    >
                      {task.title}
                    </button>
                  </li>
                ))}
              </ul>
              {hidden > 0 ? (
                <button
                  className="mt-1 px-1 text-xs text-muted"
                  type="button"
                  onClick={() => {
                    setCursor(day.startOf("day"));
                    setMode("day");
                  }}
                >
                  + {hidden} more
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function sameDay(task: TaskDto, day: DateTime, timeZone: string): boolean {
  if (!task.dueAt) return false;
  return DateTime.fromISO(task.dueAt, { zone: "utc" }).setZone(timeZone).toISODate() === day.toISODate();
}

function shift(cursor: DateTime, mode: Mode, direction: number): DateTime {
  if (mode === "month") return cursor.plus({ months: direction }) as DateTime;
  if (mode === "week") return cursor.plus({ weeks: direction }) as DateTime;
  return cursor.plus({ days: direction }) as DateTime;
}

function visibleRange(cursor: DateTime, mode: Mode): { from: string; to: string; days: DateTime[] } {
  if (mode === "day") {
    const from = cursor.startOf("day").toUTC().toISO() ?? "";
    const to = cursor.endOf("day").toUTC().toISO() ?? "";
    return { from, to, days: [cursor] };
  }
  if (mode === "week") {
    const start = cursor.minus({ days: cursor.weekday - 1 }).startOf("day");
    const days = Array.from({ length: 7 }, (_, index) => start.plus({ days: index }));
    return { from: start.toUTC().toISO() ?? "", to: days[6]?.endOf("day").toUTC().toISO() ?? "", days };
  }
  const monthStart = cursor.startOf("month");
  const gridStart = monthStart.minus({ days: monthStart.weekday - 1 });
  const days = Array.from({ length: 42 }, (_, index) => gridStart.plus({ days: index }));
  const last = days[41];
  return { from: gridStart.toUTC().toISO() ?? "", to: last?.endOf("day").toUTC().toISO() ?? "", days };
}
