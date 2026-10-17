import { createHash } from "node:crypto";
import mongoose, { type FilterQuery } from "mongoose";
import {
  RecurrenceError,
  assertTimeZone,
  nextSeriesDue,
  postponeDue,
  todayBounds,
  type Priority,
  type RecurrenceRule,
  type ListColor,
  type ListIcon,
} from "@vela/shared";
import { HttpError, isDuplicateKey } from "../http.js";
import { Idempotency, List, ListMember, Occurrence, OccurrenceException, Reminder, Tag, Task, User, type TaskRecord } from "../models.js";
import { toOccurrenceDto, toTaskDto } from "../serialize.js";
import { accessibleListIds, assertListAccess, assertOwnedTags, createList, inboxId, listAccess } from "./organize.js";
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
  occurrenceScope?: "this" | "following";
}

export interface TaskQuery {
  view: "inbox" | "today" | "upcoming" | "all" | "completed" | "list" | "tag" | "calendar" | "archived" | "search" | "trash";
  listId?: string;
  tagId?: string;
  q?: string;
  priority?: Priority;
  due?: "none" | "overdue";
  started?: "waiting";
  pinned?: "true";
  assignee?: "me";
  from?: string;
  to?: string;
  topLevel?: "true" | "false";
}

function conflict(task?: ReturnType<typeof toTaskDto>) {
  return new HttpError(409, "CONFLICT", "This task changed. Reload it and try again.", undefined, task);
}

async function raiseConflict(userId: string, taskId: mongoose.Types.ObjectId): Promise<never> {
  const current = await Task.findById(taskId);
  if (!current || !(await canSeeTask(userId, asRecord(current)))) throw conflict();
  throw conflict(toTaskDto(asRecord(current)));
}

function asRecord(task: unknown): TaskRecord {
  return task as TaskRecord;
}

export async function listTasks(userId: string, query: TaskQuery) {
  const user = await User.findById(userId);
  if (!user) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
  const listIds = await accessibleListIds(userId);
  const visibility = { $or: [{ userId }, { listId: { $in: listIds } }] };
  const filter: FilterQuery<TaskRecord> = { deletedAt: null, ...visibility };
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
      await assertListAccess(userId, query.listId);
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
    case "trash":
      filter.deletedAt = { $ne: null };
      break;
    case "search":
      filter.status = { $ne: "archived" };
      if (query.q) {
        const pattern = query.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const tags = await Tag.find({ userId, name: { $regex: pattern, $options: "i" } }).select("_id");
        delete filter.$or;
        filter.$and = [
          visibility,
          {
            $or: [
              { title: { $regex: pattern, $options: "i" } },
              { description: { $regex: pattern, $options: "i" } },
              ...(tags.length > 0 ? [{ tagIds: { $in: tags.map((tag) => tag._id) } }] : []),
            ],
          },
        ];
      }
      break;
    default:
      break;
  }

  if (query.topLevel === "true") filter.parentId = null;
  if (query.priority) filter.priority = query.priority;
  if (query.due === "none") {
    if (query.view === "today" || query.view === "upcoming" || query.view === "calendar") {
      throw new HttpError(400, "DUE_FILTER", "That view is already limited by date.");
    }
    filter.dueAt = null;
  }
  if (query.due === "overdue") {
    if (query.view === "upcoming" || query.view === "calendar" || query.view === "completed" || query.view === "trash" || query.view === "archived") {
      throw new HttpError(400, "DUE_FILTER", "That view does not list overdue tasks.");
    }
    filter.status = "open";
    filter.dueAt = { $ne: null, $lt: new Date(bounds.start) };
  }
  if (query.started === "waiting") {
    if (query.view !== "today" && query.view !== "upcoming") {
      throw new HttpError(400, "START_FILTER", "That view already includes tasks that have not started.");
    }
    filter.startAt = { $gt: new Date() };
  } else if (query.view === "today" || query.view === "upcoming") {
    const started = { $or: [{ startAt: null }, { startAt: { $lte: new Date() } }] };
    const visibility = filter.$or;
    delete filter.$or;
    filter.$and = [{ $or: visibility }, started];
  }
  if (query.pinned === "true") {
    if (query.view === "calendar") throw new HttpError(400, "PIN_FILTER", "Calendar stays laid out by date.");
    filter.pinned = true;
  }
  if (query.assignee === "me") {
    if (query.view === "calendar") throw new HttpError(400, "ASSIGNEE_FILTER", "Calendar stays laid out by date.");
    filter.assigneeId = userId;
  }
  if (query.listId && query.view !== "list" && query.view !== "inbox") {
    await assertListAccess(userId, query.listId);
    filter.listId = query.listId;
  }
  if (query.tagId && query.view !== "tag") {
    await assertOwnedTags(userId, [query.tagId]);
    filter.tagIds = query.tagId;
  }

  const sort: Record<string, 1 | -1> =
    query.view === "trash"
      ? { deletedAt: -1, createdAt: -1 }
      : query.view === "today" || query.view === "upcoming" || query.view === "calendar"
        ? { dueAt: 1, sortOrder: 1 }
        : { pinned: -1, sortOrder: 1, createdAt: 1 };
  const found = await Task.find(filter).sort(sort).limit(501);
  const truncated = found.length > 500;
  const tasks = await withParentTitles(
    await withAssigneeNames(await withSubtaskCounts(userId, listIds, found.slice(0, 500).map((task) => toTaskDto(asRecord(task))))),
  );

  if (!occurrences) return { tasks, truncated };
  const visible = await Task.find({ deletedAt: null, ...visibility }).select("_id").limit(500);
  const history = await Occurrence.find({ taskId: { $in: visible.map((task) => task._id) } })
    .sort({ actedAt: -1 })
    .limit(100);
  const related = await Task.find({ _id: { $in: history.map((row) => row.taskId) } });
  const titles = new Map(related.map((task) => [task._id.toString(), task.title]));
  return {
    tasks,
    truncated,
    occurrences: history.map((row) => toOccurrenceDto(row, titles.get(row.taskId.toString()) ?? "Task")),
  };
}

export async function getTask(userId: string, taskId: string) {
  const task = await requireOpenTask(userId, taskId);
  const listIds = await accessibleListIds(userId);
  const subtasks = await Task.find({
    parentId: task._id,
    deletedAt: null,
    $or: [{ userId }, { listId: { $in: listIds } }],
  }).sort({ sortOrder: 1 });
  const named = await withParentTitles(
    await withAssigneeNames([toTaskDto(asRecord(task)), ...subtasks.map((item) => toTaskDto(asRecord(item)))]),
  );
  const namedTask = named[0];
  if (!namedTask) throw new HttpError(404, "NOT_FOUND", "Task not found.");
  const [counted] = await withSubtaskCounts(userId, listIds, [namedTask]);
  return { task: counted ?? namedTask, subtasks: named.slice(1) };
}

async function withParentTitles<T extends { parentId: string | null }>(tasks: T[]): Promise<Array<T & { parentTitle: string | null }>> {
  const ids = [...new Set(tasks.flatMap((task) => (task.parentId ? [task.parentId] : [])))];
  const parents = ids.length === 0 ? [] : await Task.find({ _id: { $in: ids } }).select("title");
  const titles = new Map(parents.map((parent) => [parent._id.toString(), parent.title]));
  return tasks.map((task) => ({ ...task, parentTitle: task.parentId ? (titles.get(task.parentId) ?? null) : null }));
}

async function withSubtaskCounts(userId: string, listIds: mongoose.Types.ObjectId[], tasks: ReturnType<typeof toTaskDto>[]) {
  if (tasks.length === 0) return tasks;
  const children = await Task.find({
    parentId: { $in: tasks.map((task) => task.id) },
    deletedAt: null,
    $or: [{ userId }, { listId: { $in: listIds } }],
  }).select("parentId status");
  const totals = new Map<string, { subtaskCount: number; openSubtaskCount: number }>();
  for (const child of children) {
    const key = child.parentId?.toString() ?? "";
    const current = totals.get(key) ?? { subtaskCount: 0, openSubtaskCount: 0 };
    current.subtaskCount += 1;
    if (child.status === "open") current.openSubtaskCount += 1;
    totals.set(key, current);
  }
  return tasks.map((task) => ({ ...task, ...(totals.get(task.id) ?? { subtaskCount: 0, openSubtaskCount: 0 }) }));
}

async function withAssigneeNames(tasks: ReturnType<typeof toTaskDto>[]) {
  const ids = [...new Set(tasks.flatMap((task) => (task.assigneeId ? [task.assigneeId] : [])))];
  if (ids.length === 0) return tasks;
  const people = await User.find({ _id: { $in: ids } }).select("name");
  const names = new Map(people.map((person) => [person._id.toString(), person.name]));
  return tasks.map((task) => ({ ...task, assigneeName: task.assigneeId ? (names.get(task.assigneeId) ?? null) : null }));
}

async function nextSortOrder(listId: unknown, parentId: unknown): Promise<number> {
  const first = await Task.findOne({ listId, parentId: parentId ?? null, deletedAt: null }).sort({ sortOrder: 1 });
  return (first?.sortOrder ?? 0) - 1;
}

async function appendSortOrder(listId: unknown, parentId: unknown): Promise<number> {
  const last = await Task.findOne({ listId, parentId: parentId ?? null, deletedAt: null }).sort({ sortOrder: -1 });
  return (last?.sortOrder ?? -1) + 1;
}

export async function createTask(userId: string, input: TaskInput) {
  const user = await User.findById(userId);
  if (!user) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
  let parentId: mongoose.Types.ObjectId | null = null;
  if (input.parentId) {
    const parent = await requireOpenTask(userId, input.parentId);
    if (!parent) throw new HttpError(404, "NOT_FOUND", "Parent task not found.");
    if (parent.parentId) throw new HttpError(400, "SUBTASK_DEPTH", "Subtasks cannot contain their own subtasks.");
    if (parent.status !== "open") throw new HttpError(400, "NOT_OPEN", "Only an open task can have a new subtask.");
    parentId = parent._id;
  }
  const listId = input.listId ?? (parentId ? undefined : (await inboxId(userId)).toString());
  const resolvedList = input.listId ?? (parentId ? (await Task.findById(parentId))?.listId.toString() : listId);
  if (!resolvedList) throw new HttpError(400, "LIST_REQUIRED", "Choose a list.");
  await assertListAccess(userId, resolvedList);
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
  if (input.recurrence?.until && input.dueAt && new Date(input.dueAt).getTime() > new Date(input.recurrence.until).getTime()) {
    throw new HttpError(400, "END_BEFORE_DUE", "The end date has to be on or after the due date.");
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
    series: null,
    omittedDueAts: [],
    seriesId: _id,
    sortOrder: parentId ? await appendSortOrder(resolvedList, parentId) : await nextSortOrder(resolvedList, null),
    pinned: false,
    assigneeId: null,
    revision: 0,
    completedAt: null,
    deletedAt: null,
  });
  await syncReminder(asRecord(task));
  return toTaskDto(asRecord(task));
}

function copyFields(task: TaskRecord): TaskInput {
  const recurrence = task.recurrence
    ? {
        frequency: task.recurrence.frequency,
        interval: task.recurrence.interval,
        ...(task.recurrence.byWeekday && task.recurrence.byWeekday.length > 0 ? { byWeekday: [...task.recurrence.byWeekday] } : {}),
        ...(task.recurrence.until ? { until: task.recurrence.until.toISOString() } : {}),
        ...(task.recurrence.count ? { count: task.recurrence.count } : {}),
      }
    : null;
  return {
    title: task.title,
    description: task.description,
    listId: task.listId.toString(),
    dueAt: task.dueAt ? task.dueAt.toISOString() : null,
    dueHasTime: task.dueHasTime,
    startAt: task.startAt ? task.startAt.toISOString() : null,
    timeZone: task.timeZone,
    priority: task.priority,
    estimatedMinutes: task.estimatedMinutes,
    reminderOffsetMinutes: task.reminderOffsetMinutes,
    recurrence,
  };
}

async function ownedTagIds(userId: string, tagIds: { toString(): string }[]): Promise<string[]> {
  if (tagIds.length === 0) return [];
  const rows = await Tag.find({ userId, _id: { $in: tagIds } }).select("_id");
  return rows.map((tag) => tag._id.toString());
}

export async function duplicateTask(userId: string, taskId: string) {
  const source = asRecord(await requireOpenTask(userId, taskId));
  let parentId: string | null = source.parentId ? source.parentId.toString() : null;
  if (parentId) {
    const parent = await Task.findById(parentId).select("status deletedAt");
    if (!parent || parent.deletedAt || parent.status !== "open") parentId = null;
  }
  const copy = await createTask(userId, {
    ...copyFields(source),
    tagIds: await ownedTagIds(userId, source.tagIds),
    parentId,
  });
  if (source.parentId && !parentId) {
    const sortOrder = await appendSortOrder(copy.listId, null);
    const placed = await Task.findOneAndUpdate({ _id: copy.id }, { $set: { sortOrder } }, { new: true });
    return placed ? toTaskDto(asRecord(placed)) : copy;
  }
  if (!source.parentId) {
    const children = await Task.find({ parentId: source._id, deletedAt: null, status: { $ne: "archived" } });
    for (const child of children) {
      const record = asRecord(child);
      await createTask(userId, {
        ...copyFields(record),
        tagIds: await ownedTagIds(userId, record.tagIds),
        parentId: copy.id,
        listId: copy.listId,
      });
    }
  }
  return copy;
}

export async function duplicateList(userId: string, listId: string) {
  if (!(await listAccess(userId, listId))) throw new HttpError(404, "NOT_FOUND", "List not found.");
  const source = await List.findById(listId);
  if (!source) throw new HttpError(404, "NOT_FOUND", "List not found.");
  const created = await createList(userId, {
    name: `${source.name.slice(0, 75)} copy`,
    color: source.color as ListColor,
    icon: source.icon as ListIcon,
  });
  const parents = await Task.find({ listId: source._id, parentId: null, deletedAt: null, status: { $ne: "archived" } }).sort({
    sortOrder: 1,
    createdAt: 1,
  });
  let copiedTasks = 0;
  for (const parent of parents) {
    const record = asRecord(parent);
    const copy = await createTask(userId, {
      ...copyFields(record),
      tagIds: await ownedTagIds(userId, record.tagIds),
      listId: created.id,
      parentId: null,
    });
    copiedTasks += 1;
    const children = await Task.find({ parentId: record._id, deletedAt: null, status: { $ne: "archived" } }).sort({ sortOrder: 1 });
    for (const child of children) {
      const childRecord = asRecord(child);
      await createTask(userId, {
        ...copyFields(childRecord),
        tagIds: await ownedTagIds(userId, childRecord.tagIds),
        parentId: copy.id,
        listId: created.id,
      });
      copiedTasks += 1;
    }
  }
  return { ...created, copiedTasks };
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

function taskFingerprint(task: {
  title: string;
  description?: string | null;
  listId: { toString(): string };
  parentId?: { toString(): string } | null;
  dueAt?: Date | null;
  dueHasTime?: boolean | null;
  startAt?: Date | null;
  timeZone: string;
  priority: string;
  tagIds: { toString(): string }[];
  assigneeId?: { toString(): string } | null;
  estimatedMinutes?: number | null;
  reminderOffsetMinutes?: number | null;
  sortOrder: number;
  recurrence?: {
    frequency: string;
    interval: number;
    byWeekday?: number[] | null;
    until?: Date | null;
    count?: number | null;
  } | null;
  anchorAt?: Date | null;
}) {
  return JSON.stringify({
    title: task.title,
    description: task.description ?? "",
    listId: task.listId.toString(),
    parentId: task.parentId ? task.parentId.toString() : null,
    dueAt: task.dueAt ? task.dueAt.toISOString() : null,
    dueHasTime: Boolean(task.dueHasTime),
    startAt: task.startAt ? task.startAt.toISOString() : null,
    timeZone: task.timeZone,
    priority: task.priority,
    tagIds: task.tagIds.map((id) => id.toString()).sort(),
    assigneeId: task.assigneeId ? task.assigneeId.toString() : null,
    estimatedMinutes: task.estimatedMinutes ?? null,
    reminderOffsetMinutes: task.reminderOffsetMinutes ?? null,
    sortOrder: task.sortOrder,
    recurrence: task.recurrence
      ? {
          frequency: task.recurrence.frequency,
          interval: task.recurrence.interval,
          byWeekday: [...(task.recurrence.byWeekday ?? [])].sort(),
          until: task.recurrence.until ? task.recurrence.until.toISOString() : null,
          count: task.recurrence.count ?? null,
        }
      : null,
    anchorAt: task.anchorAt ? task.anchorAt.toISOString() : null,
  });
}

export async function updateTask(userId: string, taskId: string, revision: number, input: TaskInput) {
  const task = await requireOpenTask(userId, taskId);
  if (task.revision !== revision) throw conflict(toTaskDto(asRecord(task)));
  const scope = input.occurrenceScope ?? (task.series ? "this" : "following");
  if (scope === "this") return updateThisOccurrence(userId, asRecord(task), revision, input);
  const slotBefore = task.series?.dueAt ?? task.dueAt;
  const before = taskFingerprint(task);
  const hadSeries = Boolean(task.series);
  if (input.title !== undefined) task.title = input.title;
  if (input.description !== undefined) task.description = input.description;
  if (input.listId !== undefined) {
    const moving = input.listId !== task.listId.toString();
    if (moving) {
      const role = await listAccess(userId, task.listId.toString());
      if (role !== "owner" && task.userId.toString() !== userId) {
        throw new HttpError(403, "LIST_OWNER", "Only the list owner can move someone else's task.");
      }
      task.assigneeId = null;
    }
    await assertListAccess(userId, input.listId);
    task.listId = new mongoose.Types.ObjectId(input.listId);
  }
  if (input.parentId !== undefined) {
    if (input.parentId === null) {
      if (task.parentId) task.sortOrder = await appendSortOrder(task.listId, null);
      task.parentId = null;
    } else {
      const parent = await requireOpenTask(userId, input.parentId);
      if (parent.parentId || parent._id.equals(task._id)) {
        throw new HttpError(400, "SUBTASK_DEPTH", "Subtasks cannot contain their own subtasks.");
      }
      if (parent.status !== "open") throw new HttpError(400, "NOT_OPEN", "Only an open task can have a new subtask.");
      if (await Task.exists({ parentId: task._id })) {
        throw new HttpError(400, "SUBTASK_DEPTH", "A task with subtasks cannot become a subtask.");
      }
      if (!task.parentId?.equals(parent._id)) {
        if (task.listId.toString() !== parent.listId.toString()) {
          const role = await listAccess(userId, task.listId.toString());
          if (role !== "owner" && task.userId.toString() !== userId) {
            throw new HttpError(403, "LIST_OWNER", "Only the list owner can move someone else's task.");
          }
          task.assigneeId = null;
        }
        task.listId = parent.listId;
        task.parentId = parent._id;
        task.sortOrder = await appendSortOrder(parent.listId, parent._id);
      }
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
  if (task.recurrence?.until && task.dueAt && task.dueAt.getTime() > task.recurrence.until.getTime()) {
    throw new HttpError(400, "END_BEFORE_DUE", "The end date has to be on or after the due date.");
  }
  if (before === taskFingerprint(task) && !hadSeries) {
    return toTaskDto(asRecord(task));
  }
  const updated = await Task.findOneAndUpdate(
    { _id: task._id, revision },
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
        assigneeId: task.assigneeId,
        estimatedMinutes: task.estimatedMinutes,
        reminderOffsetMinutes: task.reminderOffsetMinutes,
        sortOrder: task.sortOrder,
        recurrence: task.recurrence,
        anchorAt: task.anchorAt,
        series: null,
        ...(!task.recurrence ? { omittedDueAts: [], pausedRecurrence: null } : {}),
      },
      $inc: { revision: 1 },
    },
    { new: true },
  );
  if (!updated) await raiseConflict(userId, task._id);
  if (!task.recurrence) {
    await OccurrenceException.deleteMany({ userId, taskId: task._id });
  } else if (slotBefore) {
    await OccurrenceException.deleteMany({ userId, taskId: task._id, originalDueAt: { $gte: slotBefore } });
  }
  await syncReminder(asRecord(updated));
  return toTaskDto(asRecord(updated));
}

const seriesOnlyFields = ["listId", "parentId", "startAt", "timeZone", "tagIds", "estimatedMinutes", "recurrence"] as const;

async function updateThisOccurrence(userId: string, task: TaskRecord, revision: number, input: TaskInput) {
  const slot = task.series?.dueAt ?? task.dueAt;
  if (!task.recurrence || !slot) {
    throw new HttpError(400, "NOT_RECURRING", "Only a repeating task with a due date can change one occurrence.");
  }
  if (seriesOnlyFields.some((key) => input[key] !== undefined)) {
    throw new HttpError(400, "OCCURRENCE_SCOPE", "Repeat, list, tags, start date, and estimate apply to the whole series.");
  }
  const template = {
    title: task.series?.title ?? task.title,
    description: task.series?.description ?? task.description,
    priority: task.series?.priority ?? task.priority,
    dueAt: slot,
    dueHasTime: task.series?.dueHasTime ?? task.dueHasTime,
    reminderOffsetMinutes: task.series?.reminderOffsetMinutes ?? task.reminderOffsetMinutes,
  };
  const next = {
    title: input.title ?? task.title,
    description: input.description ?? task.description,
    priority: input.priority ?? task.priority,
    dueAt: input.dueAt !== undefined ? (input.dueAt ? new Date(input.dueAt) : null) : task.dueAt,
    dueHasTime: input.dueHasTime ?? task.dueHasTime,
    reminderOffsetMinutes: input.reminderOffsetMinutes !== undefined ? input.reminderOffsetMinutes : task.reminderOffsetMinutes,
  };
  if (!next.dueAt) throw new HttpError(400, "RECURRENCE_REQUIRES_DUE", "A repeating task needs a due date.");
  const sameOccurrence =
    next.title === task.title &&
    (next.description ?? "") === (task.description ?? "") &&
    next.priority === task.priority &&
    (next.dueAt?.getTime() ?? null) === (task.dueAt?.getTime() ?? null) &&
    Boolean(next.dueHasTime) === Boolean(task.dueHasTime) &&
    (next.reminderOffsetMinutes ?? null) === (task.reminderOffsetMinutes ?? null);
  if (sameOccurrence) return toTaskDto(task);
  await OccurrenceException.findOneAndUpdate(
    { userId, taskId: task._id, originalDueAt: slot },
    {
      $set: {
        seriesId: task.seriesId,
        title: next.title,
        description: next.description,
        priority: next.priority,
        dueAt: next.dueAt,
        dueHasTime: next.dueHasTime,
        reminderOffsetMinutes: next.reminderOffsetMinutes,
      },
    },
    { upsert: true },
  );
  const updated = await Task.findOneAndUpdate(
    { _id: task._id, revision },
    {
      $set: {
        title: next.title,
        description: next.description,
        priority: next.priority,
        dueAt: next.dueAt,
        dueHasTime: Boolean(next.dueAt) && next.dueHasTime,
        reminderOffsetMinutes: next.reminderOffsetMinutes,
        series: template,
      },
      $inc: { revision: 1 },
    },
    { new: true },
  );
  if (!updated) await raiseConflict(userId, task._id);
  await syncReminder(asRecord(updated));
  return toTaskDto(asRecord(updated));
}

async function canSeeTask(userId: string, task: { userId: { toString(): string }; listId: { toString(): string } }) {
  if (task.userId.toString() === userId) return true;
  return (await listAccess(userId, task.listId.toString())) !== null;
}

async function requireOpenTask(userId: string, taskId: string) {
  if (!/^[a-f\d]{24}$/i.test(taskId)) throw new HttpError(404, "NOT_FOUND", "Task not found.");
  const task = await Task.findOne({ _id: taskId, deletedAt: null });
  if (!task || !(await canSeeTask(userId, task))) throw new HttpError(404, "NOT_FOUND", "Task not found.");
  return task;
}

export async function completeTask(userId: string, taskId: string) {
  const task = await requireOpenTask(userId, taskId);
  if (task.status === "archived") throw new HttpError(400, "ARCHIVED", "Unarchive the task before completing it.");
  if (!task.recurrence && task.status === "completed") return toTaskDto(asRecord(task));
  if (!task.recurrence) {
    const updated = await Task.findOneAndUpdate(
      { _id: task._id, revision: task.revision },
      { $set: { status: "completed", completedAt: new Date() }, $inc: { revision: 1 } },
      { new: true },
    );
    if (!updated) await raiseConflict(userId, task._id);
    await cancelReminders(task._id);
    const children = await Task.find({ parentId: task._id, deletedAt: null, status: "open" });
    for (const child of children) await completeTask(userId, child._id.toString());
    return toTaskDto(asRecord(updated));
  }
  return advanceRecurring(userId, asRecord(task), "completed");
}

export async function finishSubtasks(userId: string, taskId: string) {
  const task = await requireOpenTask(userId, taskId);
  if (task.status === "archived") {
    throw new HttpError(400, "ARCHIVED", "Unarchive the task before completing its subtasks.");
  }
  const children = await Task.find({ parentId: task._id, deletedAt: null, status: "open" });
  for (const child of children) await completeTask(userId, child._id.toString());
  const result = await getTask(userId, taskId);
  return result.task;
}

export async function skipTask(userId: string, taskId: string) {
  const task = await requireOpenTask(userId, taskId);
  if (!task.recurrence || !task.dueAt) {
    throw new HttpError(400, "NOT_RECURRING", "Only a repeating task with a due date can be skipped.");
  }
  return advanceRecurring(userId, asRecord(task), "skipped");
}

export async function omitOccurrence(userId: string, taskId: string) {
  const task = await requireOpenTask(userId, taskId);
  const record = asRecord(task);
  const slot = record.series?.dueAt ?? record.dueAt;
  if (!record.recurrence || !slot) {
    throw new HttpError(400, "NOT_RECURRING", "Only a repeating task with a due date can drop one date.");
  }
  await OccurrenceException.deleteOne({ userId, taskId: record._id, originalDueAt: slot });
  const omitted = [...(record.omittedDueAts ?? []), slot];
  const acted = await Occurrence.countDocuments({ taskId: record._id });
  const patch = await fieldsAfterSlot(userId, record, slot, acted, omitted);
  const finishing = patch.status === "completed";
  const updated = await Task.findOneAndUpdate(
    { _id: record._id, revision: record.revision },
    {
      $set: {
        ...patch,
        omittedDueAts: omitted,
        ...(finishing ? { pausedRecurrence: record.recurrence } : { pausedRecurrence: null }),
      },
      $inc: { revision: 1 },
    },
    { new: true },
  );
  if (!updated) await raiseConflict(userId, record._id);
  const saved = asRecord(updated);
  await syncReminder(saved);
  if (saved.status === "completed") await finishOpenChildren(userId, saved._id);
  return toTaskDto(saved);
}

export async function restoreOmittedOccurrence(userId: string, taskId: string) {
  const task = await requireOpenTask(userId, taskId);
  if (task.status === "archived") throw new HttpError(400, "ARCHIVED", "Unarchive the task before restoring a date.");
  const record = asRecord(task);
  const rule = record.recurrence ?? record.pausedRecurrence ?? null;
  if (!rule) {
    throw new HttpError(400, "NOT_RECURRING", "Only a repeating task can restore a removed date.");
  }
  const omitted = [...(record.omittedDueAts ?? [])];
  if (omitted.length === 0) {
    throw new HttpError(400, "NOTHING_TO_RESTORE", "There is no removed date to restore.");
  }
  const slot = omitted.pop()!;
  const withRule = { ...record, recurrence: rule };
  const template = seriesTemplate(withRule, slot);
  const exception = await OccurrenceException.findOne({ userId, taskId: record._id, originalDueAt: slot });
  const updated = await Task.findOneAndUpdate(
    { _id: record._id, revision: record.revision },
    {
      $set: exception
        ? {
            status: "open",
            completedAt: null,
            title: exception.title,
            description: exception.description,
            priority: exception.priority,
            dueAt: exception.dueAt,
            dueHasTime: exception.dueHasTime,
            reminderOffsetMinutes: exception.reminderOffsetMinutes,
            recurrence: rule,
            pausedRecurrence: null,
            omittedDueAts: omitted,
            series: {
              title: template.title,
              description: template.description,
              priority: template.priority,
              dueAt: slot,
              dueHasTime: template.dueHasTime,
              reminderOffsetMinutes: template.reminderOffsetMinutes,
            },
          }
        : {
            status: "open",
            completedAt: null,
            title: template.title,
            description: template.description,
            priority: template.priority,
            dueAt: slot,
            dueHasTime: template.dueHasTime,
            reminderOffsetMinutes: template.reminderOffsetMinutes,
            recurrence: rule,
            pausedRecurrence: null,
            omittedDueAts: omitted,
            series: null,
          },
      $inc: { revision: 1 },
    },
    { new: true },
  );
  if (!updated) await raiseConflict(userId, record._id);
  await syncReminder(asRecord(updated));
  return toTaskDto(asRecord(updated));
}

async function finishOpenChildren(userId: string, parentId: mongoose.Types.ObjectId) {
  const children = await Task.find({ parentId, deletedAt: null, status: "open" });
  for (const child of children) await completeTask(userId, child._id.toString());
}

function seriesTemplate(task: TaskRecord, slot: Date) {
  return (
    task.series ?? {
      title: task.title,
      description: task.description,
      priority: task.priority,
      dueAt: slot,
      dueHasTime: task.dueHasTime,
      reminderOffsetMinutes: task.reminderOffsetMinutes,
    }
  );
}

function recurrenceRule(task: TaskRecord): RecurrenceRule {
  if (!task.recurrence) throw new HttpError(400, "NOT_RECURRING", "Only a repeating task can move to the next date.");
  return {
    frequency: task.recurrence.frequency,
    interval: task.recurrence.interval,
    ...(task.recurrence.byWeekday && task.recurrence.byWeekday.length > 0
      ? { byWeekday: [...task.recurrence.byWeekday] }
      : {}),
    ...(task.recurrence.until ? { until: task.recurrence.until.toISOString() } : {}),
    ...(task.recurrence.count ? { count: task.recurrence.count } : {}),
  };
}

async function fieldsAfterSlot(userId: string, task: TaskRecord, slot: Date, acted: number, omitted: Date[]) {
  const template = seriesTemplate(task, slot);
  let nextIso: string | null;
  try {
    nextIso = nextSeriesDue(
      {
        dueAt: slot.toISOString(),
        timeZone: task.timeZone,
        rule: recurrenceRule(task),
        actedOccurrences: acted,
        anchorAt: (task.anchorAt ?? slot).toISOString(),
      },
      omitted.map((value) => value.getTime()),
    );
  } catch (error) {
    if (error instanceof RecurrenceError) throw new HttpError(400, "RECURRENCE_INVALID", error.message);
    throw error;
  }
  if (!nextIso) {
    return {
      title: template.title,
      description: template.description,
      priority: template.priority,
      dueHasTime: template.dueHasTime,
      reminderOffsetMinutes: template.reminderOffsetMinutes,
      status: "completed" as const,
      completedAt: new Date(),
      recurrence: null,
      series: null,
      omittedDueAts: [],
    };
  }
  const next = new Date(nextIso);
  const exception = await OccurrenceException.findOne({ userId, taskId: task._id, originalDueAt: next });
  if (!exception) {
    return {
      title: template.title,
      description: template.description,
      priority: template.priority,
      dueAt: next,
      dueHasTime: template.dueHasTime,
      reminderOffsetMinutes: template.reminderOffsetMinutes,
      status: "open" as const,
      completedAt: null,
      series: null,
    };
  }
  return {
    title: exception.title,
    description: exception.description,
    priority: exception.priority,
    dueAt: exception.dueAt,
    dueHasTime: exception.dueHasTime,
    reminderOffsetMinutes: exception.reminderOffsetMinutes,
    status: "open" as const,
    completedAt: null,
    series: {
      title: template.title,
      description: template.description,
      priority: template.priority,
      dueAt: next,
      dueHasTime: template.dueHasTime,
      reminderOffsetMinutes: template.reminderOffsetMinutes,
    },
  };
}

async function advanceRecurring(userId: string, task: TaskRecord, action: "completed" | "skipped") {
  const slot = task.series?.dueAt ?? task.dueAt;
  if (!slot || !task.recurrence) {
    throw new HttpError(400, "RECURRENCE_REQUIRES_DUE", "A repeating task needs a due date.");
  }
  const acted = (await Occurrence.countDocuments({ taskId: task._id })) + 1;
  const patch = await fieldsAfterSlot(userId, task, slot, acted, task.omittedDueAts ?? []);
  try {
    await Occurrence.create({
      userId,
      taskId: task._id,
      seriesId: task.seriesId,
      occurrenceDueAt: slot,
      action,
      actedAt: new Date(),
    });
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
  }
  const updated = await Task.findOneAndUpdate(
    { _id: task._id, revision: task.revision },
    { $set: patch, $inc: { revision: 1 } },
    { new: true },
  );
  if (!updated) await raiseConflict(userId, task._id);
  const saved = asRecord(updated);
  await syncReminder(saved);
  if (saved.status === "completed") await finishOpenChildren(userId, saved._id);
  return toTaskDto(saved);
}

export async function uncompleteTask(userId: string, taskId: string) {
  const task = await requireOpenTask(userId, taskId);
  if (task.status === "archived") throw new HttpError(400, "ARCHIVED", "Unarchive the task before reopening it.");
  if (!task.recurrence && task.status !== "completed") {
    throw new HttpError(400, "NOT_COMPLETED", "Only a finished task can be reopened.");
  }
  if (!task.recurrence) {
    const updated = await Task.findOneAndUpdate(
      { _id: task._id, revision: task.revision },
      { $set: { status: "open", completedAt: null }, $inc: { revision: 1 } },
      { new: true },
    );
    if (!updated) await raiseConflict(userId, task._id);
    await syncReminder(asRecord(updated));
    if (task.parentId) {
      const parent = await Task.findOne({ _id: task.parentId, deletedAt: null, status: "completed", recurrence: null });
      if (parent) {
        const reopened = await Task.findOneAndUpdate(
          { _id: parent._id, revision: parent.revision },
          { $set: { status: "open", completedAt: null }, $inc: { revision: 1 } },
          { new: true },
        );
        if (reopened) await syncReminder(asRecord(reopened));
      }
    }
    const children = await Task.find({ parentId: task._id, deletedAt: null, status: "completed", recurrence: null });
    for (const child of children) await uncompleteTask(userId, child._id.toString());
    return toTaskDto(asRecord(updated));
  }
  const record = asRecord(task);
  const latest = await Occurrence.findOne({ taskId: record._id, userId }).sort({ actedAt: -1 });
  if (latest) await latest.deleteOne();
  const restored = latest?.occurrenceDueAt ?? null;
  const template = seriesTemplate(record, restored ?? record.dueAt ?? new Date());
  const exception = restored
    ? await OccurrenceException.findOne({ userId, taskId: record._id, originalDueAt: restored })
    : null;
  const updated = await Task.findOneAndUpdate(
    { _id: record._id, revision: record.revision },
    {
      $set: exception
        ? {
            status: "open",
            completedAt: null,
            title: exception.title,
            description: exception.description,
            priority: exception.priority,
            dueAt: exception.dueAt,
            dueHasTime: exception.dueHasTime,
            reminderOffsetMinutes: exception.reminderOffsetMinutes,
            series: {
              title: template.title,
              description: template.description,
              priority: template.priority,
              dueAt: restored,
              dueHasTime: template.dueHasTime,
              reminderOffsetMinutes: template.reminderOffsetMinutes,
            },
          }
        : {
            status: "open",
            completedAt: null,
            title: template.title,
            description: template.description,
            priority: template.priority,
            dueHasTime: template.dueHasTime,
            reminderOffsetMinutes: template.reminderOffsetMinutes,
            ...(restored ? { dueAt: restored } : {}),
            series: null,
          },
      $inc: { revision: 1 },
    },
    { new: true },
  );
  if (!updated) await raiseConflict(userId, record._id);
  await syncReminder(asRecord(updated));
  return toTaskDto(asRecord(updated));
}

export async function softDeleteTask(userId: string, taskId: string) {
  const task = await requireOpenTask(userId, taskId);
  const updated = await Task.findOneAndUpdate(
    { _id: task._id, revision: task.revision },
    { $set: { deletedAt: new Date() }, $inc: { revision: 1 } },
    { new: true },
  );
  if (!updated) await raiseConflict(userId, task._id);
  const children = await Task.find({ parentId: task._id, deletedAt: null }).select("_id");
  if (children.length > 0) {
    await Task.updateMany(
      { _id: { $in: children.map((child) => child._id) } },
      { $set: { deletedAt: new Date() }, $inc: { revision: 1 } },
    );
    for (const child of children) await cancelReminders(child._id);
  }
  await cancelReminders(task._id);
  return toTaskDto(asRecord(updated));
}

const PURGE_UNDO_MS = 5 * 60 * 1000;

export async function purgeTask(userId: string, taskId: string): Promise<{ deletedIds: string[]; detachedIds: string[] }> {
  if (!/^[a-f\d]{24}$/i.test(taskId)) throw new HttpError(404, "NOT_FOUND", "Task not found.");
  const task = await Task.findOne({ _id: taskId, deletedAt: { $ne: null } });
  if (!task || !(await canSeeTask(userId, task))) throw new HttpError(404, "NOT_FOUND", "Task not found.");
  if (task.userId.toString() !== userId) {
    throw new HttpError(403, "TASK_AUTHOR", "Only the person who added this task can delete it forever.");
  }
  const children = await Task.find({ parentId: task._id });
  const deletedIds = [task._id.toString()];
  const detachedIds: string[] = [];
  for (const child of children) {
    if (child.userId.toString() === userId && child.deletedAt) deletedIds.push(child._id.toString());
    else {
      detachedIds.push(child._id.toString());
      child.parentId = null;
      child.revision += 1;
      await child.save();
    }
  }
  const purgeIds = deletedIds.map((id) => new mongoose.Types.ObjectId(id));
  const purgedAt = new Date();
  await Task.updateMany({ _id: { $in: purgeIds } }, { $set: { purgedAt }, $inc: { revision: 1 } });
  return { deletedIds, detachedIds };
}

export async function emptyTrash(userId: string): Promise<{ purged: number; kept: number; deletedIds: string[] }> {
  const mine = await Task.find({ userId, deletedAt: { $ne: null } }).select("_id parentId");
  const mineIds = new Set(mine.map((task) => task._id.toString()));
  const roots = mine.filter((task) => !task.parentId || !mineIds.has(task.parentId.toString()));
  const deletedIds: string[] = [];
  for (const task of roots) {
    const result = await purgeTask(userId, task._id.toString());
    deletedIds.push(...result.deletedIds);
  }
  const listIds = await accessibleListIds(userId);
  const kept = await Task.countDocuments({
    deletedAt: { $ne: null },
    userId: { $ne: userId },
    listId: { $in: listIds },
  });
  return { purged: deletedIds.length, kept, deletedIds };
}

export async function restorePurged(userId: string, ids: string[]): Promise<{ restored: number }> {
  const objectIds = ids.filter((id) => /^[a-f\d]{24}$/i.test(id)).map((id) => new mongoose.Types.ObjectId(id));
  if (objectIds.length === 0) throw new HttpError(404, "NOT_FOUND", "Task not found.");
  const cutoff = new Date(Date.now() - PURGE_UNDO_MS);
  const rows = await Task.find({
    _id: { $in: objectIds },
    userId,
    purgedAt: { $ne: null, $gte: cutoff },
  });
  for (const row of rows) {
    row.purgedAt = null;
    row.revision += 1;
    await row.save();
  }
  if (rows.length === 0) throw new HttpError(404, "NOT_FOUND", "Those tasks can no longer be restored.");
  return { restored: rows.length };
}

export async function hardDeleteExpiredPurges(): Promise<void> {
  const cutoff = new Date(Date.now() - PURGE_UNDO_MS);
  const rows = await Task.find({ purgedAt: { $ne: null, $lt: cutoff } })
    .setOptions({ includePurged: true })
    .select("_id");
  if (rows.length === 0) return;
  const purgeIds = rows.map((row) => row._id);
  await Occurrence.deleteMany({ taskId: { $in: purgeIds } });
  await OccurrenceException.deleteMany({ taskId: { $in: purgeIds } });
  await Reminder.deleteMany({ taskId: { $in: purgeIds } });
  await Task.deleteMany({ _id: { $in: purgeIds }, purgedAt: { $ne: null } });
}

export async function purgeSelected(
  userId: string,
  ids: string[],
): Promise<{ purged: number; kept: number; deletedIds: string[]; detachedIds: string[] }> {
  const tasks = [];
  for (const id of ids) {
    if (!/^[a-f\d]{24}$/i.test(id)) throw new HttpError(404, "NOT_FOUND", "Task not found.");
    const task = await Task.findOne({ _id: id, deletedAt: { $ne: null } });
    if (!task || !(await canSeeTask(userId, task))) throw new HttpError(404, "NOT_FOUND", "Task not found.");
    tasks.push(task);
  }
  const selected = new Set(ids);
  const roots = tasks.filter((task) => !task.parentId || !selected.has(task.parentId.toString()));
  let purged = 0;
  let kept = 0;
  const deletedIds: string[] = [];
  const detachedIds: string[] = [];
  for (const task of roots) {
    if (task.userId.toString() !== userId) {
      kept += 1;
      continue;
    }
    const result = await purgeTask(userId, task._id.toString());
    purged += result.deletedIds.length;
    deletedIds.push(...result.deletedIds);
    for (const id of result.detachedIds) {
      if (!detachedIds.includes(id)) detachedIds.push(id);
    }
  }
  return { purged, kept, deletedIds, detachedIds };
}

export async function clearCompleted(
  userId: string,
): Promise<{ deleted: number; kept: number; deletedIds: string[] }> {
  const listIds = await accessibleListIds(userId);
  const rows = await Task.find({
    deletedAt: null,
    status: "completed",
    recurrence: null,
    $or: [{ userId }, { listId: { $in: listIds } }],
  }).select("_id userId parentId");
  const mine = rows.filter((task) => task.userId.toString() === userId);
  const mineIds = new Set(mine.map((task) => task._id.toString()));
  const roots = mine.filter((task) => !task.parentId || !mineIds.has(task.parentId.toString()));
  const deletedIds: string[] = [];
  for (const task of roots) {
    deletedIds.push((await softDeleteTask(userId, task._id.toString())).id);
  }
  return { deleted: mine.length, kept: rows.length - mine.length, deletedIds };
}

export async function restoreTask(userId: string, taskId: string) {
  if (!/^[a-f\d]{24}$/i.test(taskId)) throw new HttpError(404, "NOT_FOUND", "Task not found.");
  const task = await Task.findOne({ _id: taskId, deletedAt: { $ne: null } });
  if (!task || !(await canSeeTask(userId, task))) throw new HttpError(404, "NOT_FOUND", "Task not found.");
  if (task.parentId) {
    const parent = await Task.findById(task.parentId).select("deletedAt");
    if (!parent || parent.deletedAt) {
      task.parentId = null;
      task.sortOrder = await appendSortOrder(task.listId, null);
    }
  }
  task.deletedAt = null;
  task.revision += 1;
  await task.save();
  await syncReminder(asRecord(task));
  const children = await Task.find({ parentId: task._id, deletedAt: { $ne: null } });
  for (const child of children) {
    child.deletedAt = null;
    child.revision += 1;
    await child.save();
    await syncReminder(asRecord(child));
  }
  return toTaskDto(asRecord(task));
}

export async function restoreSelected(
  userId: string,
  ids: string[],
): Promise<{ restored: number; skipped: number; tasks: ReturnType<typeof toTaskDto>[] }> {
  const deleted = [];
  let skipped = 0;
  for (const id of ids) {
    if (!/^[a-f\d]{24}$/i.test(id)) throw new HttpError(404, "NOT_FOUND", "Task not found.");
    const task = await Task.findById(id);
    if (!task || !(await canSeeTask(userId, task))) throw new HttpError(404, "NOT_FOUND", "Task not found.");
    if (!task.deletedAt) {
      skipped += 1;
      continue;
    }
    deleted.push(task);
  }
  const selected = new Set(ids);
  const roots = deleted.filter((task) => !task.parentId || !selected.has(task.parentId.toString()));
  const tasks = [];
  for (const task of roots) {
    tasks.push(await restoreTask(userId, task._id.toString()));
  }
  return { restored: tasks.length, skipped, tasks };
}

export async function archiveTask(userId: string, taskId: string) {
  const task = await requireOpenTask(userId, taskId);
  const updated = await Task.findOneAndUpdate(
    { _id: task._id, revision: task.revision },
    { $set: { status: "archived" }, $inc: { revision: 1 } },
    { new: true },
  );
  if (!updated) await raiseConflict(userId, task._id);
  const children = await Task.find({ parentId: task._id, deletedAt: null, status: { $ne: "archived" } });
  if (children.length > 0) {
    await Task.updateMany(
      { _id: { $in: children.map((child) => child._id) } },
      { $set: { status: "archived" }, $inc: { revision: 1 } },
    );
    for (const child of children) await cancelReminders(child._id);
  }
  await cancelReminders(task._id);
  return toTaskDto(asRecord(updated));
}

export async function unarchiveTask(userId: string, taskId: string) {
  const task = await requireOpenTask(userId, taskId);
  if (task.status !== "archived") throw new HttpError(400, "NOT_ARCHIVED", "Only an archived task can be restored.");
  const updated = await Task.findOneAndUpdate(
    { _id: task._id, revision: task.revision },
    { $set: { status: "open" }, $inc: { revision: 1 } },
    { new: true },
  );
  if (!updated) await raiseConflict(userId, task._id);
  const children = await Task.find({ parentId: task._id, deletedAt: null, status: "archived" });
  if (children.length > 0) {
    await Task.updateMany(
      { _id: { $in: children.map((child) => child._id) } },
      { $set: { status: "open" }, $inc: { revision: 1 } },
    );
    for (const child of children) {
      const fresh = await Task.findById(child._id);
      if (fresh) await syncReminder(asRecord(fresh));
    }
  }
  await syncReminder(asRecord(updated));
  if (task.parentId) {
    const parent = await Task.findOne({ _id: task.parentId, deletedAt: null, status: "archived" });
    if (parent) {
      const restored = await Task.findOneAndUpdate(
        { _id: parent._id, revision: parent.revision },
        { $set: { status: "open" }, $inc: { revision: 1 } },
        { new: true },
      );
      if (restored) await syncReminder(asRecord(restored));
    }
  }
  return toTaskDto(asRecord(updated));
}

export async function postponeTask(userId: string, taskId: string) {
  const task = await requireOpenTask(userId, taskId);
  if (task.status !== "open") throw new HttpError(400, "NOT_OPEN", "Only an open task can be postponed.");
  let shifted: { dueAt: string; dueHasTime: boolean };
  try {
    shifted = postponeDue({
      dueAt: task.dueAt ? task.dueAt.toISOString() : null,
      dueHasTime: Boolean(task.dueHasTime),
      timeZone: task.timeZone,
      nowIso: new Date().toISOString(),
    });
  } catch {
    throw new HttpError(400, "INVALID_TIME_ZONE", "Choose a valid time zone.");
  }
  const patch = { dueAt: shifted.dueAt, dueHasTime: shifted.dueHasTime };
  const result = task.recurrence
    ? await updateThisOccurrence(userId, asRecord(task), task.revision, { ...patch, occurrenceScope: "this" })
    : await updateTask(userId, taskId, task.revision, { ...patch, occurrenceScope: "following" });
  if (!task.recurrence) {
    const children = await Task.find({ parentId: task._id, deletedAt: null, status: "open" });
    for (const child of children) await postponeTask(userId, child._id.toString());
  }
  return result;
}

export async function pinTask(userId: string, taskId: string, pinned: boolean) {
  const task = await requireOpenTask(userId, taskId);
  if (task.status !== "open") throw new HttpError(400, "NOT_OPEN", "Only an open task can be pinned.");
  if (Boolean(task.pinned) === pinned) return toTaskDto(asRecord(task));
  const updated = await Task.findOneAndUpdate(
    { _id: task._id, deletedAt: null, revision: task.revision },
    { $set: { pinned }, $inc: { revision: 1 } },
    { new: true },
  );
  if (!updated) await raiseConflict(userId, task._id);
  return toTaskDto(asRecord(updated));
}

export async function assignTask(userId: string, taskId: string, assigneeId: string | null) {
  const task = await requireOpenTask(userId, taskId);
  if (task.status !== "open") throw new HttpError(400, "NOT_OPEN", "Only an open task can be assigned.");
  if (assigneeId) {
    const list = await List.findById(task.listId);
    if (!list) throw new HttpError(404, "NOT_FOUND", "List not found.");
    const onList = list.userId.toString() === assigneeId || Boolean(await ListMember.exists({ listId: list._id, userId: assigneeId }));
    if (!onList) throw new HttpError(400, "NOT_ON_LIST", "That person is not on this list.");
  }
  if ((task.assigneeId ? task.assigneeId.toString() : null) === assigneeId) {
    const [current] = await withAssigneeNames([toTaskDto(asRecord(task))]);
    if (!current) throw new HttpError(404, "NOT_FOUND", "Task not found.");
    return current;
  }
  const updated = await Task.findOneAndUpdate(
    { _id: task._id, deletedAt: null, revision: task.revision },
    { $set: { assigneeId: assigneeId ? new mongoose.Types.ObjectId(assigneeId) : null }, $inc: { revision: 1 } },
    { new: true },
  );
  if (!updated) await raiseConflict(userId, task._id);
  const [named] = await withAssigneeNames([toTaskDto(asRecord(updated))]);
  if (!named) throw new HttpError(404, "NOT_FOUND", "Task not found.");
  return named;
}

export async function reorderTasks(userId: string, ids: string[]) {
  const listIds = await accessibleListIds(userId);
  const visible = { deletedAt: null, $or: [{ userId }, { listId: { $in: listIds } }] };
  const tasks = await Task.find({ _id: { $in: ids }, ...visible }).select("_id parentId sortOrder");
  if (tasks.length !== ids.length) throw new HttpError(404, "NOT_FOUND", "One or more tasks were not found.");
  const parents = new Set(tasks.map((task) => (task.parentId ? task.parentId.toString() : "")));
  if (parents.size > 1) throw new HttpError(400, "SIBLING_REQUIRED", "Subtasks can only be reordered with their siblings.");
  const parentKey = [...parents][0] ?? "";
  if (parentKey) {
    const siblingCount = await Task.countDocuments({ parentId: parentKey, ...visible });
    if (siblingCount !== ids.length) {
      throw new HttpError(400, "SIBLING_REQUIRED", "Reorder every subtask of that task together.");
    }
  }
  const current = [...tasks].sort((left, right) => left.sortOrder - right.sortOrder);
  const sameOrder = ids.every((id, index) => current[index]?._id.toString() === id);
  if (sameOrder) return;
  await Task.bulkWrite(
    ids.map((id, index) => ({
      updateOne: {
        filter: { _id: id, ...visible },
        update:
          current[index]?._id.toString() === id
            ? { $set: { sortOrder: index } }
            : { $set: { sortOrder: index }, $inc: { revision: 1 } },
      },
    })),
  );
}

export async function sortListTasks(userId: string, listId: string, by: "due" | "priority" | "title") {
  const access = await listAccess(userId, listId);
  if (!access) throw new HttpError(404, "NOT_FOUND", "List not found.");
  if (access !== "owner") throw new HttpError(403, "LIST_OWNER", "Only the list owner can sort the list.");
  const priorityRank = { high: 0, medium: 1, low: 2, none: 3 } as const;
  const tasks = await Task.find({ listId, deletedAt: null, parentId: null, status: "open" });
  const ranked = [...tasks].sort((left, right) => {
    const title = left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
    if (by === "title") return title;
    if (by === "priority") return priorityRank[left.priority] - priorityRank[right.priority] || title;
    if (!left.dueAt && !right.dueAt) return title;
    if (!left.dueAt) return 1;
    if (!right.dueAt) return -1;
    return left.dueAt.getTime() - right.dueAt.getTime() || title;
  });
  const current = [...tasks].sort((left, right) => left.sortOrder - right.sortOrder);
  const sameOrder = ranked.every((task, index) => current[index]?._id.toString() === task._id.toString());
  if (sameOrder) return;
  await Task.bulkWrite(
    ranked.map((task, index) => ({
      updateOne: {
        filter: { _id: task._id, listId },
        update:
          current[index]?._id.toString() === task._id.toString()
            ? { $set: { sortOrder: index } }
            : { $set: { sortOrder: index }, $inc: { revision: 1 } },
      },
    })),
  );
}

export async function batchTasks(
  userId: string,
  ids: string[],
  action: "complete" | "delete" | "move" | "priority" | "due" | "tag" | "reopen" | "remind" | "postpone" | "start" | "estimate" | "pin" | "duplicate" | "archive" | "unarchive" | "skip" | "omit" | "assign" | "repeat" | "parent",
  listId?: string,
  priority?: Priority,
  dueAt?: string | null,
  dueHasTime?: boolean,
  tagId?: string,
  tagMode?: "add" | "remove",
  reminderOffsetMinutes?: number | null,
  startAt?: string | null,
  estimatedMinutes?: number | null,
  pinned?: boolean,
  assigneeId?: string | null,
  recurrence?: RecurrenceRule | null,
  parentId?: string | null,
) {
  if (action === "tag") {
    if (!tagId || !tagMode) throw new HttpError(400, "TAG_REQUIRED", "Choose a tag.");
    await assertOwnedTags(userId, [tagId]);
    const tasks = [];
    for (const id of ids) tasks.push(await requireOpenTask(userId, id));
    const updated = [];
    for (const task of tasks) {
      const current = task.tagIds.map((id) => id.toString());
      const nextIds = tagMode === "add" ? (current.includes(tagId) ? current : [...current, tagId]) : current.filter((id) => id !== tagId);
      if (nextIds.length === current.length && nextIds.every((id, index) => id === current[index])) {
        updated.push(toTaskDto(asRecord(task)));
        continue;
      }
      const next = await Task.findOneAndUpdate(
        { _id: task._id, deletedAt: null, revision: task.revision },
        { $set: { tagIds: nextIds.map((id) => new mongoose.Types.ObjectId(id)) }, $inc: { revision: 1 } },
        { new: true },
      );
      if (!next) await raiseConflict(userId, task._id);
      updated.push(toTaskDto(asRecord(next)));
    }
    return updated;
  }
  if (action === "due") {
    if (dueAt === undefined) throw new HttpError(400, "DUE_REQUIRED", "Choose a date.");
    const hasTime = Boolean(dueAt) && Boolean(dueHasTime);
    const tasks = [];
    for (const id of ids) tasks.push(await requireOpenTask(userId, id));
    const updated = [];
    for (const task of tasks) {
      const currentDue = task.dueAt ? task.dueAt.toISOString() : null;
      if (
        task.status !== "open" ||
        (dueAt === null && task.recurrence) ||
        (currentDue === dueAt && Boolean(task.dueHasTime) === hasTime)
      ) {
        updated.push(toTaskDto(asRecord(task)));
        continue;
      }
      if (task.recurrence) {
        updated.push(await updateThisOccurrence(userId, asRecord(task), task.revision, { dueAt, dueHasTime: hasTime }));
      } else {
        const next = await Task.findOneAndUpdate(
          { _id: task._id, deletedAt: null, revision: task.revision },
          { $set: { dueAt: dueAt ? new Date(dueAt) : null, dueHasTime: hasTime }, $inc: { revision: 1 } },
          { new: true },
        );
        if (!next) await raiseConflict(userId, task._id);
        await syncReminder(asRecord(next));
        updated.push(toTaskDto(asRecord(next)));
      }
    }
    return updated;
  }
  if (action === "priority") {
    if (!priority) throw new HttpError(400, "PRIORITY_REQUIRED", "Choose a priority.");
    const tasks = [];
    for (const id of ids) tasks.push(await requireOpenTask(userId, id));
    const updated = [];
    for (const task of tasks) {
      if (task.status !== "open" || task.priority === priority) {
        updated.push(toTaskDto(asRecord(task)));
        continue;
      }
      if (task.recurrence) {
        updated.push(await updateThisOccurrence(userId, asRecord(task), task.revision, { priority }));
      } else {
        const next = await Task.findOneAndUpdate(
          { _id: task._id, deletedAt: null, revision: task.revision },
          { $set: { priority }, $inc: { revision: 1 } },
          { new: true },
        );
        if (!next) await raiseConflict(userId, task._id);
        updated.push(toTaskDto(asRecord(next)));
      }
    }
    return updated;
  }
  if (action === "remind") {
    if (reminderOffsetMinutes === undefined) throw new HttpError(400, "REMINDER_REQUIRED", "Choose a reminder.");
    const tasks = [];
    for (const id of ids) tasks.push(await requireOpenTask(userId, id));
    const updated = [];
    for (const task of tasks) {
      if (
        task.status !== "open" ||
        (reminderOffsetMinutes !== null && !task.dueAt) ||
        (task.reminderOffsetMinutes ?? null) === reminderOffsetMinutes
      ) {
        updated.push(toTaskDto(asRecord(task)));
        continue;
      }
      if (task.recurrence) {
        updated.push(await updateThisOccurrence(userId, asRecord(task), task.revision, { reminderOffsetMinutes }));
      } else {
        const next = await Task.findOneAndUpdate(
          { _id: task._id, deletedAt: null, revision: task.revision },
          { $set: { reminderOffsetMinutes }, $inc: { revision: 1 } },
          { new: true },
        );
        if (!next) await raiseConflict(userId, task._id);
        await syncReminder(asRecord(next));
        updated.push(toTaskDto(asRecord(next)));
      }
    }
    return updated;
  }
  if (action === "pin") {
    if (pinned === undefined) throw new HttpError(400, "PIN_REQUIRED", "Choose whether to pin the tasks.");
    const tasks = [];
    for (const id of ids) tasks.push(await requireOpenTask(userId, id));
    const updated = [];
    for (const task of tasks) {
      if (task.status !== "open" || Boolean(task.pinned) === pinned) {
        updated.push(toTaskDto(asRecord(task)));
        continue;
      }
      const next = await Task.findOneAndUpdate(
        { _id: task._id, deletedAt: null, revision: task.revision },
        { $set: { pinned }, $inc: { revision: 1 } },
        { new: true },
      );
      if (!next) await raiseConflict(userId, task._id);
      updated.push(toTaskDto(asRecord(next)));
    }
    return updated;
  }
  if (action === "assign") {
    if (assigneeId === undefined) throw new HttpError(400, "ASSIGNEE_REQUIRED", "Choose who to assign.");
    const tasks = [];
    for (const id of ids) tasks.push(await requireOpenTask(userId, id));
    const updated = [];
    for (const task of tasks) {
      if (task.status !== "open" || (task.assigneeId ? task.assigneeId.toString() : null) === assigneeId) {
        updated.push(toTaskDto(asRecord(task)));
        continue;
      }
      if (assigneeId) {
        const list = await List.findById(task.listId);
        if (!list) throw new HttpError(404, "NOT_FOUND", "List not found.");
        const onList = list.userId.toString() === assigneeId || Boolean(await ListMember.exists({ listId: list._id, userId: assigneeId }));
        if (!onList) {
          updated.push(toTaskDto(asRecord(task)));
          continue;
        }
      }
      const next = await Task.findOneAndUpdate(
        { _id: task._id, deletedAt: null, revision: task.revision },
        { $set: { assigneeId: assigneeId ? new mongoose.Types.ObjectId(assigneeId) : null }, $inc: { revision: 1 } },
        { new: true },
      );
      if (!next) await raiseConflict(userId, task._id);
      updated.push(toTaskDto(asRecord(next)));
    }
    return withAssigneeNames(updated);
  }
  if (action === "repeat") {
    if (recurrence === undefined) throw new HttpError(400, "REPEAT_REQUIRED", "Choose a repeat rule.");
    const tasks = [];
    for (const id of ids) tasks.push(await requireOpenTask(userId, id));
    let untilAt: Date | null = null;
    if (recurrence?.until) {
      untilAt = new Date(recurrence.until);
      if (Number.isNaN(untilAt.getTime())) throw new HttpError(400, "RECURRENCE_INVALID", "The repeat end date is invalid.");
    }
    const updated = [];
    for (const task of tasks) {
      if (
        task.status !== "open" ||
        (recurrence && !task.dueAt) ||
        (untilAt && task.dueAt && task.dueAt.getTime() > untilAt.getTime())
      ) {
        updated.push(toTaskDto(asRecord(task)));
        continue;
      }
      const currentDays = [...(task.recurrence?.byWeekday ?? [])].sort().join(",");
      const nextDays = [...(recurrence?.byWeekday ?? [])].sort().join(",");
      const same =
        (!recurrence && !task.recurrence) ||
        Boolean(
          recurrence &&
            task.recurrence &&
            task.recurrence.frequency === recurrence.frequency &&
            task.recurrence.interval === recurrence.interval &&
            currentDays === nextDays &&
            (task.recurrence.count ?? null) === (recurrence.count ?? null) &&
            (task.recurrence.until ? task.recurrence.until.toISOString() : null) === (recurrence.until ?? null),
        );
      if (same) {
        updated.push(toTaskDto(asRecord(task)));
        continue;
      }
      const slotBefore = task.series?.dueAt ?? task.dueAt;
      const stored = recurrence
        ? {
            frequency: recurrence.frequency,
            interval: recurrence.interval,
            byWeekday: recurrence.byWeekday,
            until: recurrence.until ? new Date(recurrence.until) : null,
            count: recurrence.count,
          }
        : null;
      const next = await Task.findOneAndUpdate(
        { _id: task._id, deletedAt: null, revision: task.revision },
        {
          $set: {
            recurrence: stored,
            anchorAt: recurrence && task.dueAt ? task.dueAt : null,
            series: null,
            ...(!recurrence ? { omittedDueAts: [] } : {}),
          },
          $inc: { revision: 1 },
        },
        { new: true },
      );
      if (!next) await raiseConflict(userId, task._id);
      if (!recurrence) await OccurrenceException.deleteMany({ userId, taskId: task._id });
      else if (slotBefore) await OccurrenceException.deleteMany({ userId, taskId: task._id, originalDueAt: { $gte: slotBefore } });
      await syncReminder(asRecord(next));
      updated.push(toTaskDto(asRecord(next)));
    }
    return updated;
  }
  if (action === "estimate") {
    if (estimatedMinutes === undefined) throw new HttpError(400, "ESTIMATE_REQUIRED", "Choose an estimate.");
    const tasks = [];
    for (const id of ids) tasks.push(await requireOpenTask(userId, id));
    const updated = [];
    for (const task of tasks) {
      if (task.status !== "open" || (task.estimatedMinutes ?? null) === estimatedMinutes) {
        updated.push(toTaskDto(asRecord(task)));
        continue;
      }
      const next = await Task.findOneAndUpdate(
        { _id: task._id, deletedAt: null, revision: task.revision },
        { $set: { estimatedMinutes }, $inc: { revision: 1 } },
        { new: true },
      );
      if (!next) await raiseConflict(userId, task._id);
      updated.push(toTaskDto(asRecord(next)));
    }
    return updated;
  }
  if (action === "start") {
    if (startAt === undefined) throw new HttpError(400, "START_REQUIRED", "Choose a start date.");
    const tasks = [];
    for (const id of ids) tasks.push(await requireOpenTask(userId, id));
    const updated = [];
    for (const task of tasks) {
      const current = task.startAt ? task.startAt.toISOString() : null;
      if (task.status !== "open" || current === startAt) {
        updated.push(toTaskDto(asRecord(task)));
        continue;
      }
      const next = await Task.findOneAndUpdate(
        { _id: task._id, deletedAt: null, revision: task.revision },
        { $set: { startAt: startAt ? new Date(startAt) : null }, $inc: { revision: 1 } },
        { new: true },
      );
      if (!next) await raiseConflict(userId, task._id);
      updated.push(toTaskDto(asRecord(next)));
    }
    return updated;
  }
  if (action === "postpone") {
    const nowIso = new Date().toISOString();
    const tasks: Awaited<ReturnType<typeof requireOpenTask>>[] = [];
    for (const id of ids) {
      const task = await requireOpenTask(userId, id);
      if (task.status === "open") {
        try {
          postponeDue({
            dueAt: task.dueAt ? task.dueAt.toISOString() : null,
            dueHasTime: Boolean(task.dueHasTime),
            timeZone: task.timeZone,
            nowIso,
          });
        } catch {
          throw new HttpError(400, "INVALID_TIME_ZONE", "Choose a valid time zone.");
        }
      }
      tasks.push(task);
    }
    const selected = new Set(ids);
    const roots = tasks.filter((task) => {
      if (!task.parentId || !selected.has(task.parentId.toString())) return true;
      const parent = tasks.find((item) => item._id.toString() === task.parentId?.toString());
      return Boolean(parent?.recurrence);
    });
    const updated = [];
    for (const task of roots) {
      if (task.status !== "open") {
        updated.push(toTaskDto(asRecord(task)));
        continue;
      }
      updated.push(await postponeTask(userId, task._id.toString()));
    }
    return updated;
  }
  if (action === "duplicate") {
    const tasks = [];
    for (const id of ids) tasks.push(await requireOpenTask(userId, id));
    const selected = new Set(ids);
    const roots = tasks.filter((task) => !task.parentId || !selected.has(task.parentId.toString()));
    const updated = [];
    for (const task of roots) updated.push(await duplicateTask(userId, task._id.toString()));
    return withSubtaskCounts(userId, await accessibleListIds(userId), updated);
  }
  if (action === "archive") {
    const tasks = [];
    for (const id of ids) tasks.push(await requireOpenTask(userId, id));
    const selected = new Set(ids);
    const roots = tasks.filter((task) => !task.parentId || !selected.has(task.parentId.toString()));
    const updated = [];
    for (const task of roots) {
      if (task.status === "archived") {
        updated.push(toTaskDto(asRecord(task)));
        continue;
      }
      updated.push(await archiveTask(userId, task._id.toString()));
    }
    return updated;
  }
  if (action === "unarchive") {
    const tasks = [];
    for (const id of ids) tasks.push(await requireOpenTask(userId, id));
    const selected = new Set(ids);
    const roots = tasks.filter((task) => !task.parentId || !selected.has(task.parentId.toString()));
    const updated = [];
    for (const task of roots) {
      if (task.status !== "archived") {
        updated.push(toTaskDto(asRecord(task)));
        continue;
      }
      updated.push(await unarchiveTask(userId, task._id.toString()));
    }
    return updated;
  }
  if (action === "reopen") {
    const tasks = [];
    for (const id of ids) tasks.push(await requireOpenTask(userId, id));
    const selected = new Set(ids);
    const targets = tasks.filter((task) => !task.parentId || !selected.has(task.parentId.toString()));
    const updated = [];
    for (const task of targets) {
      if (task.status !== "completed") {
        updated.push(toTaskDto(asRecord(task)));
        continue;
      }
      updated.push(await uncompleteTask(userId, task._id.toString()));
    }
    return updated;
  }
  if (action === "omit") {
    const tasks = [];
    for (const id of ids) tasks.push(await requireOpenTask(userId, id));
    const updated = [];
    for (const task of tasks) {
      if (task.status !== "open" || !task.recurrence || !task.dueAt) {
        updated.push(toTaskDto(asRecord(task)));
        continue;
      }
      updated.push(await omitOccurrence(userId, task._id.toString()));
    }
    return updated;
  }
  if (action === "skip") {
    const tasks = [];
    for (const id of ids) tasks.push(await requireOpenTask(userId, id));
    const updated = [];
    for (const task of tasks) {
      if (task.status !== "open" || !task.recurrence || !task.dueAt) {
        updated.push(toTaskDto(asRecord(task)));
        continue;
      }
      updated.push(await skipTask(userId, task._id.toString()));
    }
    return updated;
  }
  if (action === "complete" || action === "delete") {
    const tasks: Awaited<ReturnType<typeof requireOpenTask>>[] = [];
    for (const id of ids) tasks.push(await requireOpenTask(userId, id));
    const selected = new Set(ids);
    const targets = tasks
      .filter((task) => {
        if (!task.parentId || !selected.has(task.parentId.toString())) return true;
        if (action === "delete") return false;
        const parent = tasks.find((item) => item._id.toString() === task.parentId?.toString());
        return Boolean(parent?.recurrence);
      })
      .sort((left, right) => {
        const leftNested = left.parentId && selected.has(left.parentId.toString()) ? 1 : 0;
        const rightNested = right.parentId && selected.has(right.parentId.toString()) ? 1 : 0;
        return leftNested - rightNested;
      });
    const updated = [];
    for (const task of targets) {
      if (action === "delete") {
        updated.push(await softDeleteTask(userId, task._id.toString()));
        continue;
      }
      if (task.status === "archived") {
        updated.push(toTaskDto(asRecord(task)));
        continue;
      }
      if (task.parentId && selected.has(task.parentId.toString())) {
        const fresh = await Task.findById(task._id);
        const dueMoved = Boolean(task.dueAt && fresh?.dueAt && fresh.dueAt.getTime() !== task.dueAt.getTime());
        if (!fresh || fresh.deletedAt || fresh.status === "completed" || dueMoved) continue;
      }
      updated.push(await completeTask(userId, task._id.toString()));
    }
    return updated;
  }
  if (action === "parent") {
    if (parentId === undefined) throw new HttpError(400, "PARENT_REQUIRED", "Choose a task.");
    const tasks = [];
    for (const id of ids) tasks.push(await requireOpenTask(userId, id));
    const parent = parentId ? await requireOpenTask(userId, parentId) : null;
    if (parent) {
      if (
        parent.status !== "open" ||
        Boolean(parent.parentId) ||
        ids.includes(parent._id.toString())
      ) {
        return tasks.map((task) => toTaskDto(asRecord(task)));
      }
    }
    const tails = new Map<string, number>();
    const takeTail = async (list: unknown, parentKey: unknown) => {
      const key = `${String(list)}:${parentKey ? String(parentKey) : ""}`;
      const current = tails.get(key);
      if (current !== undefined) {
        tails.set(key, current + 1);
        return current;
      }
      const start = await appendSortOrder(list, parentKey);
      tails.set(key, start + 1);
      return start;
    };
    const updated = [];
    for (const task of tasks) {
      const nextParent = parent ? parent._id.toString() : null;
      const currentParent = task.parentId ? task.parentId.toString() : null;
      const nextList = parent ? parent.listId.toString() : task.listId.toString();
      if (currentParent === nextParent && task.listId.toString() === nextList) {
        updated.push(toTaskDto(asRecord(task)));
        continue;
      }
      if (parent && (await Task.exists({ parentId: task._id, deletedAt: null }))) {
        updated.push(toTaskDto(asRecord(task)));
        continue;
      }
      if (parent && task.listId.toString() !== parent.listId.toString()) {
        const role = await listAccess(userId, task.listId.toString());
        if (role !== "owner" && task.userId.toString() !== userId) {
          updated.push(toTaskDto(asRecord(task)));
          continue;
        }
      }
      const leaving = task.listId.toString() !== nextList;
      const sortOrder = parent ? await takeTail(parent.listId, parent._id) : await takeTail(task.listId, null);
      const next = await Task.findOneAndUpdate(
        { _id: task._id, deletedAt: null, revision: task.revision },
        {
          $set: {
            parentId: parent ? parent._id : null,
            listId: parent ? parent.listId : task.listId,
            sortOrder,
            ...(leaving ? { assigneeId: null } : {}),
          },
          $inc: { revision: 1 },
        },
        { new: true },
      );
      if (!next) await raiseConflict(userId, task._id);
      updated.push(toTaskDto(asRecord(next)));
    }
    return updated;
  }
  if (!listId) throw new HttpError(400, "LIST_REQUIRED", "Choose a list.");
  await assertListAccess(userId, listId);
  const tasks = [];
  const blockedIds = new Set<string>();
  for (const id of ids) {
    const task = await requireOpenTask(userId, id);
    if (task.listId.toString() !== listId) {
      const role = await listAccess(userId, task.listId.toString());
      if (role !== "owner" && task.userId.toString() !== userId) {
        blockedIds.add(task._id.toString());
      }
    }
    tasks.push(task);
  }
  const selected = new Set(ids);
  const roots = tasks.filter((task) => !task.parentId || !selected.has(task.parentId.toString()));
  const moved = [];
  for (const task of roots) {
    const leaving = task.listId.toString() !== listId;
    const detach = Boolean(task.parentId && !selected.has(task.parentId.toString()));
    if (blockedIds.has(task._id.toString()) || (!leaving && !detach)) {
      moved.push(toTaskDto(asRecord(task)));
      continue;
    }
    const sortOrder = detach ? await appendSortOrder(listId, null) : undefined;
    const updated = await Task.findOneAndUpdate(
      { _id: task._id, deletedAt: null },
      {
        $set: {
          listId: new mongoose.Types.ObjectId(listId),
          ...(leaving ? { assigneeId: null } : {}),
          ...(detach ? { parentId: null, sortOrder } : {}),
        },
        $inc: { revision: 1 },
      },
      { new: true },
    );
    if (!updated) await raiseConflict(userId, task._id);
    if (!task.parentId) {
      await Task.updateMany(
        { parentId: task._id, deletedAt: null },
        { $set: { listId: new mongoose.Types.ObjectId(listId), ...(leaving ? { assigneeId: null } : {}) }, $inc: { revision: 1 } },
      );
    }
    moved.push(toTaskDto(asRecord(updated)));
  }
  return moved;
}
