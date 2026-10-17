import type { Priority, TaskDto, TaskStatus } from "./types.js";

export type TaskSyncOp = "create" | "update" | "delete" | "complete" | "restore" | "reopen" | "postpone";

export interface TaskMutation {
  id: string;
  baseRevision: number | null;
  entity: "task";
  entityId: string;
  op: TaskSyncOp;
  payload: Record<string, unknown>;
  base: Record<string, unknown>;
  createdAt: string;
  attempt: number;
  attention: string[] | null;
  serverRevision: number | null;
}

export function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function mergeTaskPatch(
  base: Record<string, unknown>,
  local: Record<string, unknown>,
  server: Record<string, unknown>,
): { patch: Record<string, unknown>; conflicts: string[] } {
  const patch: Record<string, unknown> = {};
  const conflicts: string[] = [];
  for (const [key, value] of Object.entries(local)) {
    if (key === "revision") continue;
    const baseValue = base[key];
    const serverValue = server[key];
    if (sameValue(value, baseValue)) continue;
    if (sameValue(value, serverValue)) continue;
    if (sameValue(baseValue, serverValue) || baseValue === undefined) {
      patch[key] = value;
      continue;
    }
    conflicts.push(key);
  }
  return { patch, conflicts };
}

export function overlayTasks(tasks: TaskDto[], mutations: TaskMutation[]): TaskDto[] {
  const next = tasks.map((task) => ({ ...task }));
  for (const mutation of mutations) {
    if (mutation.op === "create") {
      if (!next.some((task) => task.id === mutation.entityId)) next.push(draftTask(mutation));
      continue;
    }
    const index = next.findIndex((task) => task.id === mutation.entityId);
    if (index < 0) continue;
    const current = next[index];
    if (!current) continue;
    if (mutation.op === "delete") {
      next.splice(index, 1);
      continue;
    }
    if (mutation.op === "complete") {
      next[index] = { ...current, status: "completed", completedAt: mutation.createdAt };
      continue;
    }
    if (mutation.op === "restore" || mutation.op === "reopen") {
      next[index] = { ...current, status: "open", deletedAt: mutation.op === "reopen" ? current.deletedAt : null, completedAt: null };
      continue;
    }
    const overlaid = { ...current, ...taskFields(mutation.payload) };
    if (mutation.payload.occurrenceScope === "this") {
      overlaid.occurrenceOriginalDueAt = current.occurrenceOriginalDueAt ?? current.dueAt;
    }
    if (mutation.payload.occurrenceScope === "following") overlaid.occurrenceOriginalDueAt = null;
    next[index] = overlaid;
  }
  return next;
}

function draftTask(mutation: TaskMutation): TaskDto {
  const fields = taskFields(mutation.payload);
  return {
    id: mutation.entityId,
    title: fields.title ?? "Untitled",
    description: fields.description ?? "",
    status: "open",
    dueAt: fields.dueAt ?? null,
    dueHasTime: fields.dueHasTime ?? false,
    startAt: fields.startAt ?? null,
    timeZone: fields.timeZone ?? "UTC",
    priority: fields.priority ?? "none",
    listId: fields.listId ?? "",
    tagIds: fields.tagIds ?? [],
    estimatedMinutes: fields.estimatedMinutes ?? null,
    reminderOffsetMinutes: fields.reminderOffsetMinutes ?? null,
    recurrence: fields.recurrence ?? null,
    anchorAt: null,
    occurrenceOriginalDueAt: null,
    parentId: fields.parentId ?? null,
    sortOrder: 0,
    pinned: false,
    assigneeId: null,
    assigneeName: null,
    completedAt: null,
    deletedAt: null,
    createdAt: mutation.createdAt,
    updatedAt: mutation.createdAt,
    revision: 0,
  };
}

function taskFields(payload: Record<string, unknown>): Partial<TaskDto> {
  const next: Partial<TaskDto> = {};
  if (typeof payload.title === "string") next.title = payload.title;
  if (typeof payload.description === "string") next.description = payload.description;
  if (typeof payload.status === "string") next.status = payload.status as TaskStatus;
  if (payload.dueAt === null || typeof payload.dueAt === "string") next.dueAt = payload.dueAt;
  if (typeof payload.dueHasTime === "boolean") next.dueHasTime = payload.dueHasTime;
  if (payload.startAt === null || typeof payload.startAt === "string") next.startAt = payload.startAt;
  if (typeof payload.timeZone === "string") next.timeZone = payload.timeZone;
  if (typeof payload.priority === "string") next.priority = payload.priority as Priority;
  if (typeof payload.listId === "string") next.listId = payload.listId;
  if (Array.isArray(payload.tagIds)) next.tagIds = payload.tagIds.map(String);
  if (payload.estimatedMinutes === null || typeof payload.estimatedMinutes === "number") next.estimatedMinutes = payload.estimatedMinutes;
  if (payload.reminderOffsetMinutes === null || typeof payload.reminderOffsetMinutes === "number") {
    next.reminderOffsetMinutes = payload.reminderOffsetMinutes;
  }
  if (payload.parentId === null || typeof payload.parentId === "string") next.parentId = payload.parentId;
  return next;
}
