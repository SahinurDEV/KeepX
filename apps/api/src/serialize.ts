import type { ListDto, OccurrenceDto, ReminderDto, TagDto, TaskDto, UserDto } from "@vela/shared";
import type { TaskRecord } from "./models.js";

export function toUserDto(user: { _id: { toString(): string }; email: string; name: string; timeZone: string; createdAt: Date }): UserDto {
  return {
    id: user._id.toString(),
    email: user.email,
    name: user.name,
    timeZone: user.timeZone,
    createdAt: user.createdAt.toISOString(),
  };
}

export function toListDto(list: {
  _id: { toString(): string };
  name: string;
  color: string;
  icon: string;
  sortOrder: number;
  isInbox: boolean;
  archivedAt?: Date | null;
}): ListDto {
  return {
    id: list._id.toString(),
    name: list.name,
    color: list.color as ListDto["color"],
    icon: list.icon as ListDto["icon"],
    sortOrder: list.sortOrder,
    isInbox: list.isInbox,
    archivedAt: list.archivedAt ? list.archivedAt.toISOString() : null,
  };
}

export function toTagDto(tag: { _id: { toString(): string }; name: string; color: string }): TagDto {
  return { id: tag._id.toString(), name: tag.name, color: tag.color as TagDto["color"] };
}

export function toTaskDto(task: TaskRecord): TaskDto {
  const recurrence = task.recurrence
    ? {
        frequency: task.recurrence.frequency,
        interval: task.recurrence.interval,
        ...(task.recurrence.byWeekday && task.recurrence.byWeekday.length > 0
          ? { byWeekday: task.recurrence.byWeekday }
          : {}),
        ...(task.recurrence.until ? { until: task.recurrence.until.toISOString() } : {}),
        ...(task.recurrence.count ? { count: task.recurrence.count } : {}),
      }
    : null;
  return {
    id: task._id.toString(),
    title: task.title,
    description: task.description ?? "",
    status: task.status,
    dueAt: task.dueAt ? task.dueAt.toISOString() : null,
    dueHasTime: Boolean(task.dueHasTime),
    startAt: task.startAt ? task.startAt.toISOString() : null,
    timeZone: task.timeZone,
    priority: task.priority,
    listId: task.listId.toString(),
    tagIds: task.tagIds.map((id) => id.toString()),
    estimatedMinutes: task.estimatedMinutes ?? null,
    reminderOffsetMinutes: task.reminderOffsetMinutes ?? null,
    recurrence,
    anchorAt: task.anchorAt ? task.anchorAt.toISOString() : null,
    parentId: task.parentId ? task.parentId.toString() : null,
    sortOrder: task.sortOrder,
    completedAt: task.completedAt ? task.completedAt.toISOString() : null,
    deletedAt: task.deletedAt ? task.deletedAt.toISOString() : null,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    revision: task.revision,
  };
}

export function toOccurrenceDto(
  row: {
    _id: { toString(): string };
    taskId: { toString(): string };
    action: "completed" | "skipped";
    occurrenceDueAt: Date;
    actedAt: Date;
  },
  title: string,
): OccurrenceDto {
  return {
    id: row._id.toString(),
    taskId: row.taskId.toString(),
    title,
    action: row.action,
    occurrenceDueAt: row.occurrenceDueAt.toISOString(),
    actedAt: row.actedAt.toISOString(),
  };
}

export function toReminderDto(
  row: { _id: { toString(): string }; taskId: { toString(): string }; fireAt: Date; status: ReminderDto["status"] },
  title: string,
): ReminderDto {
  return {
    id: row._id.toString(),
    taskId: row.taskId.toString(),
    title,
    fireAt: row.fireAt.toISOString(),
    status: row.status,
    channel: "in_app",
  };
}
