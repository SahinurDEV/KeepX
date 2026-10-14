import { DateTime } from "luxon";
import type { RecurrenceRule, Weekday } from "./types.js";

export interface AdvanceInput {
  dueAt: string;
  timeZone: string;
  rule: RecurrenceRule;
  /** Completed or skipped occurrences, including the one just acted on. */
  actedOccurrences: number;
  anchorAt: string;
}

const MAX_DAILY_STEPS = 366 * 30;

export class RecurrenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecurrenceError";
  }
}

export function advanceOccurrence(input: AdvanceInput): string | null {
  const zone = input.timeZone;
  if (!DateTime.now().setZone(zone).isValid) {
    throw new RecurrenceError("The time zone is not recognized.");
  }
  const current = DateTime.fromISO(input.dueAt, { zone: "utc" }).setZone(zone);
  const anchor = DateTime.fromISO(input.anchorAt, { zone: "utc" }).setZone(zone);
  if (!current.isValid || !anchor.isValid) {
    throw new RecurrenceError("The due date or anchor is not a valid instant.");
  }
  if (input.rule.count !== undefined && input.actedOccurrences >= input.rule.count) {
    return null;
  }

  const next = computeNext(current, anchor, input.rule);
  if (!next) return null;
  if (input.rule.until) {
    const until = DateTime.fromISO(input.rule.until, { zone: "utc" });
    if (!until.isValid) throw new RecurrenceError("The repeat end date is invalid.");
    if (next.toUTC().toMillis() > until.toMillis()) return null;
  }
  return next.toUTC().toISO();
}

function computeNext(current: DateTime, anchor: DateTime, rule: RecurrenceRule): DateTime | null {
  const interval = rule.interval;
  if (rule.frequency === "daily") return current.plus({ days: interval });
  if (rule.frequency === "monthly") return addMonthsKeepingAnchorDay(current, anchor, interval);
  if (rule.frequency === "yearly") return addMonthsKeepingAnchorDay(current, anchor, interval * 12);
  if (rule.byWeekday && rule.byWeekday.length > 0) return nextWeeklyPattern(current, anchor, rule);
  return current.plus({ weeks: interval });
}

function addMonthsKeepingAnchorDay(current: DateTime, anchor: DateTime, months: number): DateTime {
  const shifted = current.plus({ months });
  const daysInMonth = shifted.daysInMonth ?? anchor.day;
  return shifted.set({ day: Math.min(anchor.day, daysInMonth) });
}

function startOfIsoWeek(value: DateTime): DateTime {
  return value.startOf("day").minus({ days: value.weekday - 1 });
}

function nextWeeklyPattern(
  current: DateTime,
  anchor: DateTime,
  rule: RecurrenceRule,
): DateTime | null {
  const weekdays = [...(rule.byWeekday ?? [])].sort((a, b) => a - b);
  const anchorWeek = startOfIsoWeek(anchor);
  let cursor = current.startOf("day").plus({ days: 1 });
  for (let step = 0; step < MAX_DAILY_STEPS; step += 1) {
    const weekDiff = Math.round(startOfIsoWeek(cursor).diff(anchorWeek, "days").days / 7);
    const weekday = cursor.weekday as Weekday;
    if (weekDiff >= 0 && weekDiff % rule.interval === 0 && weekdays.includes(weekday)) {
      return cursor.set({
        hour: current.hour,
        minute: current.minute,
        second: current.second,
        millisecond: current.millisecond,
      });
    }
    cursor = cursor.plus({ days: 1 });
  }
  return null;
}
