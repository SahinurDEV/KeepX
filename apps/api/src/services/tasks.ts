import { createHash } from "node:crypto";
import mongoose, { type FilterQuery } from "mongoose";
import {
  RecurrenceError,
  advanceOccurrence,
  assertTimeZone,
  todayBounds,
  type Priority,
  type RecurrenceRule,
} from "@vela/shared";
import { HttpError, isDuplicateKey } from "../http.js";
import { Idempotency, Occurrence, Task, User, type TaskRecord } from "../models.js";
import { toOccurrenceDto, toTaskDto } from "../serialize.js";
import { assertOwnedList, assertOwnedTags, inboxId } from "./organize.js";
import { cancelReminders, syncReminder } from "./reminders.js";

export interface TaskInput {
  title?: string;
  description?: string;
  listId?: string;
  parentId?: string | null;
  dueAt?: string | null;
  dueHasTime?: boolean;
  startAt?: string | null;
  timeZone?: string;
  priority?: Priority;
  tagIds?: string[];
  estimatedMinutes?: number | null;
  reminderOffsetMinutes?: number | null;
  recurrence?: RecurrenceRule | null;
}

export interface TaskQuery {
  view: "inbox" | "today" | "upcoming" | "all" | "completed" | "list" | "tag" | "calendar" | "archived" | "search";
  listId?: string;
  tagId?: string;
  q?: string;
  priority?: Priority;
  from?: string;
  to?: string;
  topLevel?: "true" | "false";
}

const conflict = () => new HttpError(409, "CONFLICT", "This task changed. Reload it and try again.");

function asRecord(task: unknown): TaskRecord {
  return task as TaskRecord;
}

export async function listTasks(userId: string, query: TaskQuery) {
  const user = await User.findById(userId);
  if (!user) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
  const filter: FilterQuery<TaskRecord> = { userId, deletedAt: null };
  const bounds = todayBounds(user.timeZone, new Date().toISOString());
  let occurrences = false;

  switch (query.view) {
    case "inbox": {
      filter.listId = await inboxId(userId);
      filter.status = "open";
      filter.parentId = null;
      break;
    }
    case "today":
      filter.status = "open";
      filter.dueAt = { $ne: null, $lte: new Date(bounds.end) };
      break;
    case "upcoming":
      filter.status = "open";
      filter.dueAt = { $gt: new Date(bounds.end) };
      break;
    case "all":
      filter.status = "open";
      filter.parentId = null;
      break;
    case "completed":
      filter.status = "completed";
      filter.recurrence = null;
      occurrences = true;
      break;
    case "list":
      if (!query.listId) throw new HttpError(400, "LIST_REQUIRED", "Choose a list.");
      await assertOwnedList(userId, query.listId);
      filter.listId = query.listId;
      filter.status = "open";
      filter.parentId = null;
      break;
    case "tag":
      if (!query.tagId) throw new HttpError(400, "TAG_REQUIRED", "Choose a tag.");
      await assertOwnedTags(userId, [query.tagId]);
      filter.tagIds = query.tagId;
      filter.status = "open";
      filter.parentId = null;
      break;
    case "calendar":
      if (!query.from || !query.to) throw new HttpError(400, "RANGE_REQUIRED", "Choose a calendar range.");
      filter.dueAt = { $gte: new Date(query.from), $lte: new Date(query.to) };
      filter.status = { $in: ["open", "completed"] };
      break;
    case "archived":
      filter.status = "archived";
      break;
    case "search":
      filter.status = { $ne: "archived" };
      if (query.q) {
        const pattern = query.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        filter.$or = [{ title: { $regex: pattern, $options: "i" } }, { description: { $regex: pattern, $options: "i" } }];
      }
      break;
    default:
      break;
  }

  if (query.topLevel === "true") filter.parentId = null;
  if (query.priority) filter.priority = query.priority;
  if (query.listId && query.view !== "list" && query.view !== "inbox") {
    await assertOwnedList(userId, query.listId);
    filter.listId = query.listId;
  }
  if (query.tagId && query.view !== "tag") {
    await assertOwnedTags(userId, [query.tagId]);
    filter.tagIds = query.tagId;
  }

  const sort: Record<string, 1 | -1> =
    query.view === "today" || query.view === "upcoming" || query.view === "calendar"
      ? { dueAt: 1, sortOrder: 1 }
      : { sortOrder: 1, createdAt: 1 };
  const found = await Task.find(filter).sort(sort).limit(501);
  const truncated = found.length > 500;
  const tasks = found.slice(0, 500).map((task) => toTaskDto(asRecord(task)));

  if (!occurrences) return { tasks, truncated };
  const history = await Occurrence.find({ userId }).sort({ actedAt: -1 }).limit(100);
  const related = await Task.find({ userId, _id: { $in: history.map((row) => row.taskId) } });
  const titles = new Map(related.map((task) => [task._id.toString(), task.title]));
  return {
    tasks,
    truncated,
    occurrences: history.map((row) => toOccurrenceDto(row, titles.get(row.taskId.toString()) ?? "Task")),
  };
}

export async function getTask(userId: string, taskId: string) {
  const task = await Task.findOne({ _id: taskId, userId, deletedAt: null });
  if (!task) throw new HttpError(404, "NOT_FOUND", "Task not found.");
  const subtasks = await Task.find({ userId, parentId: task._id, deletedAt: null }).sort({ sortOrder: 1 });
  return { task: toTaskDto(asRecord(task)), subtasks: subtasks.map((item) => toTaskDto(asRecord(item))) };
}

async function nextSortOrder(userId: string, listId: unknown, parentId: unknown): Promise<number> {
  const first = await Task.findOne({ userId, listId, parentId: parentId ?? null, deletedAt: null }).sort({ sortOrder: 1 });
  return (first?.sortOrder ?? 0) - 1;
}

export async function createTask(userId: string, input: TaskInput) {
  const user = await User.findById(userId);
  if (!user) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
  let parentId: mongoose.Types.ObjectId | null = null;
  if (input.parentId) {
    const parent = await Task.findOne({ _id: input.parentId, userId, deletedAt: null });
    if (!parent) throw new HttpError(404, "NOT_FOUND", "Parent task not found.");
    if (parent.parentId) throw new HttpError(400, "SUBTASK_DEPTH", "Subtasks cannot contain their own subtasks.");
    parentId = parent._id;
  }
  const listId = input.listId ?? (parentId ? undefined : (await inboxId(userId)).toString());
  const resolvedList = input.listId ?? (parentId ? (await Task.findById(parentId))?.listId.toString() : listId);
  if (!resolvedList) throw new HttpError(400, "LIST_REQUIRED", "Choose a list.");
  await assertOwnedList(userId, resolvedList);
  if (input.tagIds) await assertOwnedTags(userId, input.tagIds);
  const timeZone = input.timeZone ?? user.timeZone;
  try {
    assertTimeZone(timeZone);
  } catch {
    throw new HttpError(400, "INVALID_TIME_ZONE", "Choose a valid time zone.");
  }
  if (input.recurrence && !input.dueAt) {
    throw new HttpError(400, "RECURRENCE_REQUIRES_DUE", "A repeating task needs a due date.");
  }
  const _id = new mongoose.Types.ObjectId();
  const dueAt = input.dueAt ? new Date(input.dueAt) : null;
  const task = await Task.create({
    _id,
    userId,
    listId: resolvedList,
    parentId,
    title: input.title,
    description: input.description ?? "",
    status: "open",
    dueAt,
    dueHasTime: input.dueHasTime ?? false,
    startAt: input.startAt ? new Date(input.startAt) : null,
    timeZone,
    priority: input.priority ?? "none",
    tagIds: input.tagIds ?? [],
    estimatedMinutes: input.estimatedMinutes ?? null,
    reminderOffsetMinutes: input.reminderOffsetMinutes ?? null,
    recurrence: input.recurrence ?? null,
    anchorAt: input.recurrence && dueAt ? dueAt : null,
    seriesId: _id,
    sortOrder: await nextSortOrder(userId, resolvedList, parentId),
    revision: 0,
    completedAt: null,
    deletedAt: null,
  });
  await syncReminder(asRecord(task));
  return toTaskDto(asRecord(task));
}

export async function createTaskIdempotent(userId: string, key: string, input: TaskInput) {
  const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const existing = await Idempotency.findOne({ userId, key });
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "This idempotency key was already used for a different task.");
    }
    if (existing.statusCode === 0) {
      throw new HttpError(409, "IDEMPOTENCY_IN_PROGRESS", "That task is already being created.");
    }
    return existing.responseBody as ReturnType<typeof toTaskDto>;
  }
  try {
    await Idempotency.create({ userId, key, requestHash, statusCode: 0, responseBody: null });
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const winner = await Idempotency.findOne({ userId, key });
    if (winner?.statusCode && winner.responseBody) return winner.responseBody as ReturnType<typeof toTaskDto>;
    throw new HttpError(409, "IDEMPOTENCY_IN_PROGRESS", "That task is already being created.");
  }
  try {
    const task = await createTask(userId, input);
    await Idempotency.updateOne({ userId, key }, { $set: { statusCode: 201, responseBody: task } });
    return task;
  } catch (error) {
    await Idempotency.deleteOne({ userId, key, statusCode: 0 });
    throw error;
  }
}

export async function updateTask(userId: string, taskId: string, revision: number, input: TaskInput) {
  const task = await Task.findOne({ _id: taskId, userId, deletedAt: null });
  if (!task) throw new HttpError(404, "NOT_FOUND", "Task not found.");
  if (task.revision !== revision) throw conflict();
  if (input.title !== undefined) task.title = input.title;
  if (input.description !== undefined) task.description = input.description;
  if (input.listId !== undefined) {
    await assertOwnedList(userId, input.listId);
    task.listId = new mongoose.Types.ObjectId(input.listId);
  }
  if (input.parentId !== undefined) {
    if (input.parentId === null) task.parentId = null;
    else {
      const parent = await Task.findOne({ _id: input.parentId, userId, deletedAt: null });
      if (!parent) throw new HttpError(404, "NOT_FOUND", "Parent task not found.");
      if (parent.parentId || parent._id.equals(task._id)) {
        throw new HttpError(400, "SUBTASK_DEPTH", "Subtasks cannot contain their own subtasks.");
      }
      task.parentId = parent._id;
    }
  }
  if (input.dueAt !== undefined) task.dueAt = input.dueAt ? new Date(input.dueAt) : null;
  if (input.dueHasTime !== undefined) task.dueHasTime = input.dueHasTime;
  if (!task.dueAt) task.dueHasTime = false;
  if (input.startAt !== undefined) task.startAt = input.startAt ? new Date(input.startAt) : null;
  if (input.timeZone !== undefined) {
    try {
      assertTimeZone(input.timeZone);
    } catch {
      throw new HttpError(400, "INVALID_TIME_ZONE", "Choose a valid time zone.");
    }
    task.timeZone = input.timeZone;
  }
  if (input.priority !== undefined) task.priority = input.priority;
  if (input.tagIds !== undefined) {
    await assertOwnedTags(userId, input.tagIds);
    task.tagIds = input.tagIds.map((id) => new mongoose.Types.ObjectId(id));
  }
  if (input.estimatedMinutes !== undefined) task.estimatedMinutes = input.estimatedMinutes;
  if (input.reminderOffsetMinutes !== undefined) task.reminderOffsetMinutes = input.reminderOffsetMinutes;
  if (input.recurrence !== undefined) {
    task.recurrence = input.recurrence
      ? {
          frequency: input.recurrence.frequency,
          interval: input.recurrence.interval,
          byWeekday: input.recurrence.byWeekday,
          until: input.recurrence.until ? new Date(input.recurrence.until) : null,
          count: input.recurrence.count,
        }
      : null;
    task.anchorAt = input.recurrence && task.dueAt ? task.dueAt : null;
  }
  if (task.recurrence && !task.dueAt) {
    throw new HttpError(400, "RECURRENCE_REQUIRES_DUE", "A repeating task needs a due date.");
  }
  const updated = await Task.findOneAndUpdate(
    { _id: task._id, userId, revision },
    {
      $set: {
        title: task.title,
        description: task.description,
        listId: task.listId,
        parentId: task.parentId,
        dueAt: task.dueAt,
        dueHasTime: task.dueHasTime,
        startAt: task.startAt,
        timeZone: task.timeZone,
        priority: task.priority,
        tagIds: task.tagIds,
        estimatedMinutes: task.estimatedMinutes,
        reminderOffsetMinutes: task.reminderOffsetMinutes,
        recurrence: task.recurrence,
        anchorAt: task.anchorAt,
      },
      $inc: { revision: 1 },
    },
    { new: true },
  );
  if (!updated) throw conflict();
  await syncReminder(asRecord(updated));
  return toTaskDto(asRecord(updated));
}

async function requireOpenTask(userId: string, taskId: string) {
  const task = await Task.findOne({ _id: taskId, userId, deletedAt: null });
  if (!task) throw new HttpError(404, "NOT_FOUND", "Task not found.");
  return task;
}

export async function completeTask(userId: string, taskId: string) {
  const task = await requireOpenTask(userId, taskId);
  if (task.status === "archived") throw new HttpError(400, "ARCHIVED", "Unarchive the task before completing it.");
  if (!task.recurrence) {
    const updated = await Task.findOneAndUpdate(
      { _id: task._id, userId, revision: task.revision },
      { $set: { status: "completed", completedAt: new Date() }, $inc: { revision: 1 } },
      { new: true },
    );
    if (!updated) throw conflict();
    await cancelReminders(task._id);
    return toTaskDto(asRecord(updated));
  }
  return advanceRecurring(userId, asRecord(task), "completed");
}

export async function skipTask(userId: string, taskId: string) {
  const task = await requireOpenTask(userId, taskId);
  if (!task.recurrence || !task.dueAt) {
    throw new HttpError(400, "NOT_RECURRING", "Only a repeating task with a due date can be skipped.");
  }
  return advanceRecurring(userId, asRecord(task), "skipped");
}

async function advanceRecurring(userId: string, task: TaskRecord, action: "completed" | "skipped") {
  if (!task.dueAt || !task.recurrence) {
    throw new HttpError(400, "RECURRENCE_REQUIRES_DUE", "A repeating task needs a due date.");
  }
  const acted = (await Occurrence.countDocuments({ taskId: task._id })) + 1;
  let nextIso: string | null;
  try {
    nextIso = advanceOccurrence({
      dueAt: task.dueAt.toISOString(),
      timeZone: task.timeZone,
      rule: {
        frequency: task.recurrence.frequency,
        interval: task.recurrence.interval,
        ...(task.recurrence.byWeekday && task.recurrence.byWeekday.length > 0
          ? { byWeekday: [...task.recurrence.byWeekday] }
          : {}),
        ...(task.recurrence.until ? { until: task.recurrence.until.toISOString() } : {}),
        ...(task.recurrence.count ? { count: task.recurrence.count } : {}),
      },
      actedOccurrences: acted,
      anchorAt: (task.anchorAt ?? task.dueAt).toISOString(),
    });
  } catch (error) {
    if (error instanceof RecurrenceError) throw new HttpError(400, "RECURRENCE_INVALID", error.message);
    throw error;
  }
  try {
    await Occurrence.create({
      userId,
      taskId: task._id,
      seriesId: task.seriesId,
      occurrenceDueAt: task.dueAt,
      action,
      actedAt: new Date(),
    });
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
  }
  const patch = nextIso
    ? { dueAt: new Date(nextIso), status: "open", completedAt: null }
    : { status: "completed" as const, completedAt: new Date() };
  const updated = await Task.findOneAndUpdate(
    { _id: task._id, userId, revision: task.revision },
    { $set: patch, $inc: { revision: 1 } },
    { new: true },
  );
  if (!updated) throw conflict();
  await syncReminder(asRecord(updated));
  return toTaskDto(asRecord(updated));
}

export async function uncompleteTask(userId: string, taskId: string) {
  const task = await requireOpenTask(userId, taskId);
  if (!task.recurrence) {
    const updated = await Task.findOneAndUpdate(
      { _id: task._id, userId, revision: task.revision },
      { $set: { status: "open", completedAt: null }, $inc: { revision: 1 } },
      { new: true },
    );
    if (!updated) throw conflict();
    await syncReminder(asRecord(updated));
    return toTaskDto(asRecord(updated));
  }
  const latest = await Occurrence.findOne({ taskId: task._id, userId }).sort({ actedAt: -1 });
  if (latest) await latest.deleteOne();
  const updated = await Task.findOneAndUpdate(
    { _id: task._id, userId, revision: task.revision },
    {
      $set: {
        status: "open",
        completedAt: null,
        ...(latest ? { dueAt: latest.occurrenceDueAt } : {}),
      },
      $inc: { revision: 1 },
    },
    { new: true },
  );
  if (!updated) throw conflict();
  await syncReminder(asRecord(updated));
  return toTaskDto(asRecord(updated));
}

export async function softDeleteTask(userId: string, taskId: string) {
  const task = await requireOpenTask(userId, taskId);
  const updated = await Task.findOneAndUpdate(
    { _id: task._id, userId, revision: task.revision },
    { $set: { deletedAt: new Date() }, $inc: { revision: 1 } },
    { new: true },
  );
  if (!updated) throw conflict();
  await Task.updateMany({ userId, parentId: task._id, deletedAt: null }, { $set: { deletedAt: new Date() } });
  await cancelReminders(task._id);
  return toTaskDto(asRecord(updated));
}

export async function restoreTask(userId: string, taskId: string) {
  const task = await Task.findOne({ _id: taskId, userId, deletedAt: { $ne: null } });
  if (!task) throw new HttpError(404, "NOT_FOUND", "Task not found.");
  task.deletedAt = null;
  task.revision += 1;
  await task.save();
  await syncReminder(asRecord(task));
  return toTaskDto(asRecord(task));
}

export async function archiveTask(userId: string, taskId: string) {
  const task = await requireOpenTask(userId, taskId);
  const updated = await Task.findOneAndUpdate(
    { _id: task._id, userId, revision: task.revision },
    { $set: { status: "archived" }, $inc: { revision: 1 } },
    { new: true },
  );
  if (!updated) throw conflict();
  await cancelReminders(task._id);
  return toTaskDto(asRecord(updated));
}

export async function unarchiveTask(userId: string, taskId: string) {
  const task = await requireOpenTask(userId, taskId);
  const updated = await Task.findOneAndUpdate(
    { _id: task._id, userId, revision: task.revision },
    { $set: { status: "open" }, $inc: { revision: 1 } },
    { new: true },
  );
  if (!updated) throw conflict();
  await syncReminder(asRecord(updated));
  return toTaskDto(asRecord(updated));
}

export async function reorderTasks(userId: string, ids: string[]) {
  const count = await Task.countDocuments({ userId, _id: { $in: ids }, deletedAt: null });
  if (count !== ids.length) throw new HttpError(404, "NOT_FOUND", "One or more tasks were not found.");
  await Task.bulkWrite(
    ids.map((id, index) => ({
      updateOne: {
        filter: { _id: id, userId },
        update: { $set: { sortOrder: index }, $inc: { revision: 1 } },
      },
    })),
  );
}

export async function batchTasks(userId: string, ids: string[], action: "complete" | "delete") {
  const tasks = [];
  for (const id of ids) {
    tasks.push(action === "complete" ? await completeTask(userId, id) : await softDeleteTask(userId, id));
  }
  return tasks;
}
