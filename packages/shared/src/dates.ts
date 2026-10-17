import { DateTime } from "luxon";

export function todayBounds(timeZone: string, nowIso: string): { start: string; end: string } {
  const now = instantInZone(nowIso, timeZone);
  const start = now.startOf("day").toUTC().toISO();
  const end = now.endOf("day").toUTC().toISO();
  if (!start || !end) throw new Error("Could not resolve today in that time zone.");
  return { start, end };
}

export function isOverdue(dueAt: string, timeZone: string, nowIso: string): boolean {
  const now = instantInZone(nowIso, timeZone);
  const due = DateTime.fromISO(dueAt, { zone: "utc" }).setZone(timeZone);
  return due.isValid && due < now.startOf("day");
}

export function formatDueLabel(dueAt: string, timeZone: string, nowIso: string, withTime: boolean): string {
  const now = instantInZone(nowIso, timeZone);
  const due = DateTime.fromISO(dueAt, { zone: "utc" }).setZone(timeZone);
  if (!due.isValid) return "Invalid date";
  const dayDiff = Math.round(due.startOf("day").diff(now.startOf("day"), "days").days);
  let day: string;
  if (dayDiff === 0) day = "Today";
  else if (dayDiff === 1) day = "Tomorrow";
  else if (dayDiff === -1) day = "Yesterday";
  else day = due.toFormat("LLL d");
  if (!withTime) return day;
  return `${day}, ${due.toFormat("h:mm a")}`;
}

export function combineDateAndTime(
  date: string,
  time: string | null,
  timeZone: string,
): { dueAt: string; dueHasTime: boolean } {
  const [year, month, day] = date.split("-").map((part) => Number(part));
  if (!year || !month || !day) throw new Error("Choose a valid date.");
  let hour = 0;
  let minute = 0;
  const dueHasTime = Boolean(time);
  if (time) {
    const [h, m] = time.split(":").map((part) => Number(part));
    if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) {
      throw new Error("Choose a valid time.");
    }
    hour = h;
    minute = m;
  }
  const zoned = DateTime.fromObject(
    { year, month, day, hour, minute, second: 0, millisecond: 0 },
    { zone: timeZone },
  );
  if (!zoned.isValid) throw new Error("That date does not exist in this time zone.");
  const dueAt = zoned.toUTC().toISO();
  if (!dueAt) throw new Error("Could not save that date.");
  return { dueAt, dueHasTime };
}

export function splitDue(dueAt: string, timeZone: string, dueHasTime: boolean): { date: string; time: string } {
  const due = DateTime.fromISO(dueAt, { zone: "utc" }).setZone(timeZone);
  return {
    date: due.toFormat("yyyy-MM-dd"),
    time: dueHasTime ? due.toFormat("HH:mm") : "",
  };
}

export function postponeDue(input: {
  dueAt: string | null;
  dueHasTime: boolean;
  timeZone: string;
  nowIso: string;
}): { dueAt: string; dueHasTime: boolean } {
  const now = instantInZone(input.nowIso, input.timeZone);
  const base = input.dueAt ? DateTime.fromISO(input.dueAt, { zone: "utc" }).setZone(input.timeZone) : now;
  if (!base.isValid) throw new Error("Could not postpone that date.");
  const next = base.plus({ days: 1 });
  if (!next.isValid) throw new Error("Could not postpone that date.");
  if (input.dueAt && input.dueHasTime) {
    const dueAt = next.toUTC().toISO();
    if (!dueAt) throw new Error("Could not postpone that date.");
    return { dueAt, dueHasTime: true };
  }
  const dueAt = next.startOf("day").toUTC().toISO();
  if (!dueAt) throw new Error("Could not postpone that date.");
  return { dueAt, dueHasTime: false };
}

export function assertTimeZone(timeZone: string): void {
  if (!DateTime.now().setZone(timeZone).isValid) {
    throw new Error("The time zone is not recognized.");
  }
}

function instantInZone(nowIso: string, timeZone: string): DateTime {
  assertTimeZone(timeZone);
  const now = DateTime.fromISO(nowIso, { zone: "utc" }).setZone(timeZone);
  if (!now.isValid) throw new Error("The time zone is not recognized.");
  return now;
}
