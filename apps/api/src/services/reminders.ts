import type { Types } from "mongoose";
import { Reminder, Task, type TaskRecord } from "../models.js";
import { toReminderDto } from "../serialize.js";

export async function syncReminder(task: TaskRecord): Promise<void> {
  await Reminder.updateMany({ taskId: task._id, status: "scheduled" }, { $set: { status: "cancelled" } });
  if (task.deletedAt || task.status !== "open" || !task.dueAt || task.reminderOffsetMinutes === null || task.reminderOffsetMinutes === undefined) {
    return;
  }
  const fireAt = new Date(task.dueAt.getTime() - task.reminderOffsetMinutes * 60_000);
  await Reminder.create({
    userId: task.userId,
    taskId: task._id,
    fireAt,
    channel: "in_app",
    status: "scheduled",
  });
}

export async function cancelReminders(taskId: Types.ObjectId): Promise<void> {
  await Reminder.updateMany({ taskId, status: "scheduled" }, { $set: { status: "cancelled" } });
}

export async function pendingReminders(userId: string) {
  const rows = await Reminder.find({ userId, status: "scheduled", fireAt: { $lte: new Date() } })
    .sort({ fireAt: 1 })
    .limit(20);
  const taskIds = rows.map((row) => row.taskId);
  const tasks = await Task.find({ _id: { $in: taskIds }, userId, deletedAt: null });
  const titles = new Map(tasks.map((task) => [task._id.toString(), task.title]));
  return rows
    .filter((row) => titles.has(row.taskId.toString()))
    .map((row) => toReminderDto(row, titles.get(row.taskId.toString()) ?? "Task"));
}

export async function acknowledgeReminder(userId: string, reminderId: string): Promise<void> {
  const updated = await Reminder.findOneAndUpdate(
    { _id: reminderId, userId, status: "scheduled" },
    { $set: { status: "delivered", deliveredAt: new Date() } },
  );
  if (updated) return;
  const existing = await Reminder.findOne({ _id: reminderId, userId });
  if (!existing) {
    const { HttpError } = await import("../http.js");
    throw new HttpError(404, "NOT_FOUND", "Reminder not found.");
  }
}
