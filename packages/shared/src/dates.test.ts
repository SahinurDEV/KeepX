import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { assertCatalogIntegrity, PLATFORM_CATALOG } from "./catalog.js";
import { formatDueLabel, isOverdue, todayBounds } from "./dates.js";

describe("dates", () => {
  it("bounds today in the given time zone", () => {
    const now = DateTime.fromObject(
      { year: 2026, month: 10, day: 14, hour: 23, minute: 30 },
      { zone: "America/New_York" },
    )
      .toUTC()
      .toISO();
    const bounds = todayBounds("America/New_York", now ?? "");
    const start = DateTime.fromISO(bounds.start, { zone: "utc" }).setZone("America/New_York");
    expect(start.day).toBe(14);
    expect(start.hour).toBe(0);
    expect(isOverdue(bounds.start, "America/New_York", now ?? "")).toBe(false);
  });

  it("labels yesterday, today, and tomorrow", () => {
    const now = "2026-10-14T15:00:00.000Z";
    const zone = "UTC";
    expect(formatDueLabel("2026-10-13T15:00:00.000Z", zone, now, false)).toBe("Yesterday");
    expect(formatDueLabel("2026-10-14T18:00:00.000Z", zone, now, false)).toBe("Today");
    expect(formatDueLabel("2026-10-15T15:00:00.000Z", zone, now, true)).toBe("Tomorrow, 3:00 PM");
  });
});

describe("download catalog", () => {
  it("only links platforms that can actually be opened", () => {
    assertCatalogIntegrity();
    expect(PLATFORM_CATALOG.find((item) => item.id === "web")?.href).toBe("/login");
    expect(PLATFORM_CATALOG.filter((item) => item.status === "unavailable").every((item) => !item.href)).toBe(
      true,
    );
  });
});
