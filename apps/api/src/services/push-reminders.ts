import { DateTime } from "luxon";
import { ExpiredPushTokenError, type PushSender } from "../push.js";
import { PushDevice, Reminder, Task, User } from "../models.js";

export const PUSH_REMINDER_WINDOW_MS = 15 * 60 * 1000;
const DISPATCH_INTERVAL_MS = 30 * 1000;

export async function dispatchPushReminders(sender: PushSender | null, options?: { now?: Date }): Promise<void> {
  const now = options?.now ?? new Date();
  const rows = await Reminder.find({
    pushStatus: "pending",
    status: { $in: ["scheduled", "delivered"] },
    fireAt: { $lte: now },
  })
    .sort({ fireAt: 1 })
    .limit(50);

  for (const row of rows) {
    const claimed = await Reminder.findOneAndUpdate(
      { _id: row._id, pushStatus: "pending" },
      { $set: { pushStatus: "sending" } },
    );
    if (!claimed) continue;
    const late = claimed.fireAt.getTime() < now.getTime() - PUSH_REMINDER_WINDOW_MS;
    if (late || !sender) {
      await Reminder.updateOne({ _id: claimed._id, pushStatus: "sending" }, { $set: { pushStatus: "missed" } });
      continue;
    }
    const user = await User.findById(claimed.userId);
    const task = await Task.findOne({ _id: claimed.taskId, userId: claimed.userId, deletedAt: null, status: "open" });
    if (!user?.pushReminders || !task?.dueAt) {
      await Reminder.updateOne({ _id: claimed._id, pushStatus: "sending" }, { $set: { pushStatus: "skipped" } });
      continue;
    }
    const devices = await PushDevice.find({ userId: claimed.userId });
    const reachable = devices.flatMap((device) => {
      const provider = device.provider === "web" || device.provider === "expo" ? device.provider : null;
      if (!provider || !sender.canSend(provider)) return [];
      return [{ provider, token: device.token, id: device._id }];
    });
    if (reachable.length === 0) {
      await Reminder.updateOne({ _id: claimed._id, pushStatus: "sending" }, { $set: { pushStatus: "missed" } });
      continue;
    }
    const title = task.title.replace(/\s+/g, " ").trim().slice(0, 140) || "Task";
    const due = DateTime.fromJSDate(task.dueAt, { zone: "utc" }).setZone(user.timeZone);
    const when = due.isValid ? due.toFormat("ccc, LLL d, yyyy, t") : "the scheduled time";
    let sent = 0;
    let failed = 0;
    for (const device of reachable) {
      try {
        await sender.send({
          provider: device.provider,
          token: device.token,
          title: `Reminder: ${title}`,
          body: `${title} is due ${when}.`,
        });
        sent += 1;
      } catch (error) {
        if (error instanceof ExpiredPushTokenError) {
          await PushDevice.deleteOne({ _id: device.id });
          continue;
        }
        failed += 1;
        console.error(JSON.stringify({ level: "error", event: "reminder_push_failed" }));
      }
    }
    const pushStatus = sent > 0 ? "sent" : failed > 0 ? "failed" : "skipped";
    await Reminder.updateOne(
      { _id: claimed._id, pushStatus: "sending" },
      { $set: sent > 0 ? { pushStatus, pushSentAt: new Date() } : { pushStatus } },
    );
  }
}

export function startPushReminderLoop(sender: PushSender | null): () => void {
  const run = () => {
    void dispatchPushReminders(sender).catch(() => {
      console.error(JSON.stringify({ level: "error", event: "reminder_push_dispatch_failed" }));
    });
  };
  const timer = setInterval(run, DISPATCH_INTERVAL_MS);
  timer.unref();
  void run();
  return () => clearInterval(timer);
}
