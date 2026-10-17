import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { advanceOccurrence, nextSeriesDue } from "./recurrence.js";
import type { RecurrenceRule } from "./types.js";

const zone = "America/New_York";

function iso(year: number, month: number, day: number, hour = 9, minute = 0): string {
  const value = DateTime.fromObject({ year, month, day, hour, minute }, { zone }).toUTC().toISO();
  if (!value) throw new Error("fixture");
  return value;
}

function advance(dueAt: string, rule: RecurrenceRule, acted = 1, anchorAt = dueAt): string | null {
  return advanceOccurrence({ dueAt, timeZone: zone, rule, actedOccurrences: acted, anchorAt });
}

describe("advanceOccurrence", () => {
  it("adds daily intervals in the task time zone", () => {
    const due = iso(2026, 3, 7, 9);
    const next = advance(due, { frequency: "daily", interval: 1 });
    const local = DateTime.fromISO(next ?? "", { zone: "utc" }).setZone(zone);
    expect(local.day).toBe(8);
    expect(local.hour).toBe(9);
  });

  it("keeps 9:00 local across the US spring-forward", () => {
    const due = iso(2026, 3, 7, 9);
    const next = advance(due, { frequency: "daily", interval: 1 });
    const local = DateTime.fromISO(next ?? "", { zone: "utc" }).setZone(zone);
    expect(local.toISODate()).toBe("2026-03-08");
    expect(local.hour).toBe(9);
  });

  it("steps weekdays and then wraps to the next week", () => {
    const monday = iso(2026, 10, 12, 9);
    const rule: RecurrenceRule = { frequency: "weekly", interval: 1, byWeekday: [1, 3, 5] };
    const wednesday = advance(monday, rule, 1, monday);
    const friday = advance(wednesday ?? "", rule, 2, monday);
    const nextMonday = advance(friday ?? "", rule, 3, monday);
    expect(DateTime.fromISO(wednesday ?? "", { zone: "utc" }).setZone(zone).toISODate()).toBe("2026-10-14");
    expect(DateTime.fromISO(friday ?? "", { zone: "utc" }).setZone(zone).toISODate()).toBe("2026-10-16");
    expect(DateTime.fromISO(nextMonday ?? "", { zone: "utc" }).setZone(zone).toISODate()).toBe("2026-10-19");
  });

  it("honors a two-week interval", () => {
    const monday = iso(2026, 10, 12, 9);
    const next = advance(monday, { frequency: "weekly", interval: 2 });
    expect(DateTime.fromISO(next ?? "", { zone: "utc" }).setZone(zone).toISODate()).toBe("2026-10-26");
  });

  it("returns the 31st when the following month has that day", () => {
    const jan = iso(2026, 1, 31, 9);
    const feb = advance(jan, { frequency: "monthly", interval: 1 }, 1, jan);
    const mar = advance(feb ?? "", { frequency: "monthly", interval: 1 }, 2, jan);
    expect(DateTime.fromISO(feb ?? "", { zone: "utc" }).setZone(zone).toISODate()).toBe("2026-02-28");
    expect(DateTime.fromISO(mar ?? "", { zone: "utc" }).setZone(zone).toISODate()).toBe("2026-03-31");
  });

  it("restores February 29 on the next leap year", () => {
    const leap = iso(2024, 2, 29, 9);
    const y2025 = advance(leap, { frequency: "yearly", interval: 1 }, 1, leap);
    let cursor = y2025 ?? "";
    let acted = 2;
    let found = "";
    while (acted < 8) {
      const next = advance(cursor, { frequency: "yearly", interval: 1 }, acted, leap);
      if (!next) break;
      cursor = next;
      acted += 1;
      found = DateTime.fromISO(next, { zone: "utc" }).setZone(zone).toISODate() ?? "";
      if (found === "2028-02-29") break;
    }
    expect(found).toBe("2028-02-29");
  });

  it("stops when the occurrence count is exhausted", () => {
    const due = iso(2026, 5, 1, 9);
    expect(advance(due, { frequency: "daily", interval: 1, count: 1 }, 1)).toBeNull();
  });

  it("stops when the next date passes until", () => {
    const due = iso(2026, 5, 1, 9);
    const until = iso(2026, 5, 2, 8);
    expect(advance(due, { frequency: "daily", interval: 1, until })).toBeNull();
  });

  it("skips a cancelled slot without consuming the occurrence count", () => {
    const due = iso(2026, 5, 1, 9);
    const rule: RecurrenceRule = { frequency: "daily", interval: 1, count: 2 };
    const skipped = advance(due, rule, 1);
    const next = nextSeriesDue(
      { dueAt: due, timeZone: zone, rule, actedOccurrences: 1, anchorAt: due },
      [new Date(skipped ?? "").getTime()],
    );
    expect(DateTime.fromISO(next ?? "", { zone: "utc" }).setZone(zone).toISODate()).toBe("2026-05-03");
  });

  it("rejects an unknown time zone", () => {
    expect(() =>
      advanceOccurrence({
        dueAt: new Date().toISOString(),
        anchorAt: new Date().toISOString(),
        timeZone: "Not/AZone",
        rule: { frequency: "daily", interval: 1 },
        actedOccurrences: 1,
      }),
    ).toThrow(/time zone/i);
  });
});
