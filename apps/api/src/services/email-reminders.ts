import { DateTime } from "luxon";
import type { Mailer } from "../mailer.js";
import { Reminder, Task, User } from "../models.js";
import { hardDeleteExpiredPurges } from "./tasks.js";

export const EMAIL_REMINDER_WINDOW_MS = 15 * 60 * 1000;
const DISPATCH_INTERVAL_MS = 30 * 1000;

export async function dispatchEmailReminders(
  mailer: Mailer | null,
  options?: { now?: Date; appOrigin?: string },
): Promise<void> {
  const now = options?.now ?? new Date();
  const appOrigin = options?.appOrigin ?? "http://localhost:3000";
  const rows = await Reminder.find({
    emailStatus: "pending",
    status: { $in: ["scheduled", "delivered"] },
    fireAt: { $lte: now },
  })
    .sort({ fireAt: 1 })
    .limit(50);

  for (const row of rows) {
    const claimed = await Reminder.findOneAndUpdate(
      { _id: row._id, emailStatus: "pending" },
      { $set: { emailStatus: "sending" } },
    );
    if (!claimed) continue;
    const late = claimed.fireAt.getTime() < now.getTime() - EMAIL_REMINDER_WINDOW_MS;
    if (late || !mailer) {
      await Reminder.updateOne({ _id: claimed._id, emailStatus: "sending" }, { $set: { emailStatus: "missed" } });
      continue;
    }
    const user = await User.findById(claimed.userId);
    const task = await Task.findOne({ _id: claimed.taskId, userId: claimed.userId, deletedAt: null, status: "open" });
    if (!user?.emailReminders || !task?.dueAt) {
      await Reminder.updateOne({ _id: claimed._id, emailStatus: "sending" }, { $set: { emailStatus: "skipped" } });
      continue;
    }
    const title = task.title.replace(/\s+/g, " ").trim().slice(0, 140) || "Task";
    const due = DateTime.fromJSDate(task.dueAt, { zone: "utc" }).setZone(user.timeZone);
    const when = due.isValid ? due.toFormat("ccc, LLL d, yyyy, t") : "the scheduled time";
    try {
      await mailer.send({
        to: user.email,
        subject: `Reminder: ${title}`,
        text: `${title} is due ${when}.\n\nOpen ${appOrigin} to see it. KeepX sends this only while the API process is running.`,
      });
      await Reminder.updateOne(
        { _id: claimed._id, emailStatus: "sending" },
        { $set: { emailStatus: "sent", emailSentAt: new Date() } },
      );
    } catch {
      console.error(JSON.stringify({ level: "error", event: "reminder_email_failed" }));
      await Reminder.updateOne({ _id: claimed._id, emailStatus: "sending" }, { $set: { emailStatus: "failed" } });
    }
  }
}

export function startEmailReminderLoop(mailer: Mailer | null, appOrigin: string): () => void {
  const run = () => {
    void dispatchEmailReminders(mailer, { appOrigin }).catch(() => {
      console.error(JSON.stringify({ level: "error", event: "reminder_email_dispatch_failed" }));
    });
    void hardDeleteExpiredPurges().catch(() => undefined);
  };
  const timer = setInterval(run, DISPATCH_INTERVAL_MS);
  timer.unref();
  void run();
  return () => clearInterval(timer);
}
