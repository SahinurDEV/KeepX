import { describe, expect, it } from "vitest";
import { mergeTaskPatch, overlayTasks, type TaskMutation } from "./sync.js";
import type { TaskDto } from "./types.js";

const task = {
  id: "1",
  title: "Buy milk",
  description: "",
  status: "open",
  dueAt: null,
  dueHasTime: false,
  startAt: null,
  timeZone: "UTC",
  priority: "none",
  listId: "inbox",
  tagIds: [],
  estimatedMinutes: null,
  reminderOffsetMinutes: null,
  recurrence: null,
  anchorAt: null,
  occurrenceOriginalDueAt: null,
  parentId: null,
  sortOrder: 0,
  pinned: false,
  assigneeId: null,
  assigneeName: null,
  completedAt: null,
  deletedAt: null,
  createdAt: "2026-10-14T00:00:00.000Z",
  updatedAt: "2026-10-14T00:00:00.000Z",
  revision: 1,
} satisfies TaskDto;

describe("mergeTaskPatch", () => {
  it("keeps a local edit when the server did not change that field", () => {
    const result = mergeTaskPatch(
      { title: "Buy milk", priority: "none" },
      { title: "Buy oat milk", priority: "none" },
      { title: "Buy milk", priority: "high" },
    );
    expect(result.conflicts).toEqual([]);
    expect(result.patch).toEqual({ title: "Buy oat milk" });
  });

  it("reports a field both sides changed", () => {
    const result = mergeTaskPatch({ title: "Buy milk" }, { title: "Buy oat milk" }, { title: "Buy cream" });
    expect(result.conflicts).toEqual(["title"]);
    expect(result.patch).toEqual({});
  });
});

describe("overlayTasks", () => {
  it("shows a queued create and hides a queued completion", () => {
    const created: TaskMutation = {
      id: "local",
      baseRevision: null,
      entity: "task",
      entityId: "local",
      op: "create",
      payload: { title: "Write notes", listId: "inbox" },
      base: {},
      createdAt: "2026-10-14T01:00:00.000Z",
      attempt: 0,
      attention: null,
      serverRevision: null,
    };
    const completed: TaskMutation = { ...created, id: "done", entityId: "1", op: "complete", payload: {} };
    const shown = overlayTasks([task], [created, completed]);
    expect(shown.map((item) => item.title)).toEqual(["Buy milk", "Write notes"]);
    expect(shown[0]?.status).toBe("completed");
  });
});
