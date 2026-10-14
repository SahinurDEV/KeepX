"use client";

import { ApiError } from "@vela/api-client";
import type { TaskDto } from "@vela/shared";
import { combineDateAndTime } from "@vela/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DateTime } from "luxon";
import { useMemo, useState } from "react";
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

  async function reschedule(day: DateTime) {
    const task = (tasks.data?.tasks ?? []).find((item) => item.id === selectedId);
    if (!task) {
      toast.push("Select a task, then choose a day.");
      return;
    }
    if (!online) {
      toast.push("You are offline. Reconnect to save changes.");
      return;
    }
    const time = task.dueAt && task.dueHasTime ? DateTime.fromISO(task.dueAt, { zone: "utc" }).setZone(timeZone).toFormat("HH:mm") : null;
    try {
      const next = combineDateAndTime(day.toFormat("yyyy-MM-dd"), time, timeZone);
      await api.updateTask(task.id, { dueAt: next.dueAt, dueHasTime: next.dueHasTime, revision: task.revision });
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      toast.push(`Moved “${task.title}” to ${day.toFormat("LLL d")}.`);
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not reschedule the task.");
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
          <button key={item} className={`rounded-lg px-3 py-1 text-sm capitalize ${mode === item ? "bg-accent text-accent-ink" : "border border-line"}`} type="button" onClick={() => setMode(item)}>
            {item}
          </button>
        ))}
      </div>
      <p className="mb-3 text-sm text-muted">Select a task, then choose another day to reschedule it. The time of day stays the same when one is set.</p>
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
          return (
            <div
              key={day.toISODate()}
              className={`min-h-24 rounded-2xl border border-line bg-surface p-2 text-left shadow-sm ${day.hasSame(cursor, "month") || mode !== "month" ? "" : "opacity-50"}`}
            >
              <button className="text-xs text-muted" type="button" onClick={() => void reschedule(day)}>
                {day.toFormat("d")}
                <span className="sr-only"> Move the selected task to this day</span>
              </button>
              <ul className="mt-1 space-y-1">
                {items.slice(0, 4).map((task) => (
                  <li key={task.id}>
                    <button
                      className={`block w-full truncate rounded px-1 text-left text-xs ${selectedId === task.id ? "bg-accent text-accent-ink" : "bg-sidebar"}`}
                      type="button"
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
