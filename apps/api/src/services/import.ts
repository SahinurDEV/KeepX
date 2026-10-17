import mongoose from "mongoose";
import { assertTimeZone } from "@vela/shared";
import type { z } from "zod";
import type { importAccountSchema, revertImportSchema } from "@vela/validation";
import { HttpError } from "../http.js";
import { List, Occurrence, OccurrenceException, Reminder, Tag, Task, type TaskRecord } from "../models.js";
import { inboxId } from "./organize.js";
import { syncReminder } from "./reminders.js";

type ImportBody = z.infer<typeof importAccountSchema>;
type RevertBody = z.infer<typeof revertImportSchema>;

export interface AccountImportResult {
  lists: number;
  tags: number;
  tasks: number;
  occurrences: number;
  listIds: string[];
  tagIds: string[];
  taskIds: string[];
}

export async function importAccount(userId: string, body: ImportBody): Promise<AccountImportResult> {
  const listIds = new Set(body.lists.map((list) => list.id));
  const taskIds = new Set(body.tasks.map((task) => task.id));
  const tagIds = new Set(body.tags.map((tag) => tag.id));
  if (listIds.size !== body.lists.length || taskIds.size !== body.tasks.length) {
    throw new HttpError(400, "IMPORT_INVALID", "The export repeats a list or task id.");
  }
  const parents = new Map(body.tasks.map((task) => [task.id, task.parentId]));
  for (const task of body.tasks) {
    if (!listIds.has(task.listId)) throw new HttpError(400, "IMPORT_INVALID", "A task points at a list that is not in the file.");
    if (task.parentId) {
      if (!taskIds.has(task.parentId) || task.parentId === task.id) {
        throw new HttpError(400, "IMPORT_INVALID", "A subtask points at a task that is not in the file.");
      }
      if (parents.get(task.parentId)) throw new HttpError(400, "SUBTASK_DEPTH", "Subtasks cannot contain their own subtasks.");
    }
    if (task.tagIds.some((id) => !tagIds.has(id))) throw new HttpError(400, "IMPORT_INVALID", "A task points at a tag that is not in the file.");
    try {
      assertTimeZone(task.timeZone);
    } catch {
      throw new HttpError(400, "INVALID_TIME_ZONE", "Choose a valid time zone.");
    }
  }
  const seenOccurrences = new Set<string>();
  for (const row of body.occurrences) {
    if (!taskIds.has(row.taskId)) throw new HttpError(400, "IMPORT_INVALID", "An occurrence points at a task that is not in the file.");
    const key = `${row.taskId}:${row.occurrenceDueAt}:${row.action}`;
    if (seenOccurrences.has(key)) throw new HttpError(400, "IMPORT_INVALID", "The export repeats an occurrence.");
    seenOccurrences.add(key);
  }

  const inbox = await inboxId(userId);
  const listMap = new Map<string, mongoose.Types.ObjectId>();
  const createdListIds: string[] = [];
  for (const list of body.lists) {
    if (list.isInbox) {
      listMap.set(list.id, inbox);
      continue;
    }
    const created = await List.create({
      userId,
      name: list.name,
      color: list.color,
      icon: list.icon,
      sortOrder: list.sortOrder,
      isInbox: false,
      archivedAt: list.archivedAt ? new Date(list.archivedAt) : null,
    });
    listMap.set(list.id, created._id);
    createdListIds.push(created._id.toString());
  }

  const tagMap = new Map<string, mongoose.Types.ObjectId>();
  const createdTagIds: string[] = [];
  for (const tag of body.tags) {
    const existing = await Tag.findOne({ userId, name: tag.name });
    if (existing) {
      tagMap.set(tag.id, existing._id);
      continue;
    }
    const created = await Tag.create({ userId, name: tag.name, color: tag.color });
    tagMap.set(tag.id, created._id);
    createdTagIds.push(created._id.toString());
  }

  const taskMap = new Map<string, { id: mongoose.Types.ObjectId; seriesId: mongoose.Types.ObjectId }>();
  const createdTaskIds: string[] = [];
  const ordered = [...body.tasks.filter((task) => !task.parentId), ...body.tasks.filter((task) => task.parentId)];
  for (const task of ordered) {
    const _id = new mongoose.Types.ObjectId();
    const listId = listMap.get(task.listId);
    const parent = task.parentId ? taskMap.get(task.parentId) : undefined;
    if (!listId) throw new HttpError(400, "IMPORT_INVALID", "A task points at a list that is not in the file.");
    const dueAt = task.dueAt ? new Date(task.dueAt) : null;
    const created = await Task.create({
      _id,
      userId,
      listId,
      parentId: parent?.id ?? null,
      title: task.title,
      description: task.description,
      status: task.status,
      dueAt,
      dueHasTime: task.dueHasTime,
      startAt: task.startAt ? new Date(task.startAt) : null,
      timeZone: task.timeZone,
      priority: task.priority,
      tagIds: task.tagIds.map((id) => tagMap.get(id)).filter((id): id is mongoose.Types.ObjectId => Boolean(id)),
      estimatedMinutes: task.estimatedMinutes,
      reminderOffsetMinutes: task.reminderOffsetMinutes,
      recurrence: task.recurrence,
      anchorAt: task.recurrence && dueAt ? dueAt : null,
      series: null,
      omittedDueAts: [],
      seriesId: _id,
      sortOrder: task.sortOrder,
      pinned: task.pinned,
      assigneeId: null,
      revision: 0,
      completedAt: task.completedAt ? new Date(task.completedAt) : null,
      deletedAt: task.deletedAt ? new Date(task.deletedAt) : null,
    });
    taskMap.set(task.id, { id: created._id, seriesId: created.seriesId });
    createdTaskIds.push(created._id.toString());
    await syncReminder(created as unknown as TaskRecord);
  }

  for (const row of body.occurrences) {
    const task = taskMap.get(row.taskId);
    if (!task) continue;
    await Occurrence.create({
      userId,
      taskId: task.id,
      seriesId: task.seriesId,
      occurrenceDueAt: new Date(row.occurrenceDueAt),
      action: row.action,
      actedAt: new Date(row.actedAt),
    });
  }

  return {
    lists: createdListIds.length,
    tags: createdTagIds.length,
    tasks: createdTaskIds.length,
    occurrences: body.occurrences.length,
    listIds: createdListIds,
    tagIds: createdTagIds,
    taskIds: createdTaskIds,
  };
}

export async function revertImport(
  userId: string,
  body: RevertBody,
): Promise<{ lists: number; tags: number; tasks: number }> {
  const taskObjectIds = body.taskIds.map((id) => new mongoose.Types.ObjectId(id));
  const ownedTasks = await Task.find({ _id: { $in: taskObjectIds }, userId }).select("_id");
  const ownedTaskIds = ownedTasks.map((task) => task._id);
  if (ownedTaskIds.length > 0) {
    await Occurrence.deleteMany({ taskId: { $in: ownedTaskIds } });
    await OccurrenceException.deleteMany({ taskId: { $in: ownedTaskIds } });
    await Reminder.deleteMany({ taskId: { $in: ownedTaskIds } });
    await Task.deleteMany({ _id: { $in: ownedTaskIds } });
  }

  const listObjectIds = body.listIds.map((id) => new mongoose.Types.ObjectId(id));
  const ownedLists = await List.find({ _id: { $in: listObjectIds }, userId, isInbox: false });
  for (const list of ownedLists) {
    const leftover = await Task.countDocuments({ listId: list._id });
    if (leftover > 0) {
      const inbox = await List.findOne({ userId, isInbox: true });
      if (!inbox) throw new HttpError(500, "INBOX_MISSING", "Inbox is missing.");
      await Task.updateMany({ listId: list._id }, { $set: { listId: inbox._id }, $inc: { revision: 1 } });
    }
    await list.deleteOne();
  }

  const tagObjectIds = body.tagIds.map((id) => new mongoose.Types.ObjectId(id));
  const ownedTags = await Tag.find({ _id: { $in: tagObjectIds }, userId });
  for (const tag of ownedTags) {
    await Task.updateMany({ tagIds: tag._id }, { $pull: { tagIds: tag._id } });
    await tag.deleteOne();
  }

  return { lists: ownedLists.length, tags: ownedTags.length, tasks: ownedTaskIds.length };
}
