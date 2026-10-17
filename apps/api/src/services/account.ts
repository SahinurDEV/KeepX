import bcrypt from "bcryptjs";
import { HttpError } from "../http.js";
import {
  AccessToken,
  Idempotency,
  List,
  ListMember,
  Occurrence,
  OccurrenceException,
  PasswordReset,
  PushDevice,
  Reminder,
  Session,
  Tag,
  Task,
  User,
} from "../models.js";

export async function deleteAccount(userId: string, password: string): Promise<void> {
  const user = await User.findById(userId);
  if (!user) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
  const matches = await bcrypt.compare(password, user.passwordHash);
  if (!matches) throw new HttpError(400, "INVALID_PASSWORD", "The current password is incorrect.");
  if (user.stripeSubscriptionId) {
    throw new HttpError(409, "SUBSCRIPTION_ACTIVE", "End the subscription before deleting this account. KeepX does not cancel it.");
  }

  const ownedLists = await List.find({ userId: user._id });
  for (const list of ownedLists) {
    if (list.isInbox) continue;
    const others = await Task.find({ listId: list._id, userId: { $ne: user._id } });
    for (const task of others) {
      const inbox = await List.findOne({ userId: task.userId, isInbox: true });
      if (!inbox) throw new HttpError(500, "INBOX_MISSING", "Inbox is missing.");
      task.listId = inbox._id;
      await task.save();
    }
  }

  const ownedTaskIds = (await Task.find({ userId: user._id }).select("_id")).map((task) => task._id);
  const ownedTagIds = (await Tag.find({ userId: user._id }).select("_id")).map((tag) => tag._id);
  if (ownedTaskIds.length > 0) {
    await Task.updateMany({ userId: { $ne: user._id }, parentId: { $in: ownedTaskIds } }, { $set: { parentId: null } });
  }
  if (ownedTagIds.length > 0) {
    await Task.updateMany({ userId: { $ne: user._id }, tagIds: { $in: ownedTagIds } }, { $pull: { tagIds: { $in: ownedTagIds } } });
  }
  await Occurrence.deleteMany({ $or: [{ userId: user._id }, { taskId: { $in: ownedTaskIds } }] });
  await OccurrenceException.deleteMany({ $or: [{ userId: user._id }, { taskId: { $in: ownedTaskIds } }] });
  await Reminder.deleteMany({ $or: [{ userId: user._id }, { taskId: { $in: ownedTaskIds } }] });
  await Task.deleteMany({ userId: user._id });
  await ListMember.deleteMany({ $or: [{ userId: user._id }, { listId: { $in: ownedLists.map((list) => list._id) } }] });
  await List.deleteMany({ userId: user._id });
  await Tag.deleteMany({ userId: user._id });
  await Session.deleteMany({ userId: user._id });
  await AccessToken.deleteMany({ userId: user._id });
  await PasswordReset.deleteMany({ userId: user._id });
  await PushDevice.deleteMany({ userId: user._id });
  await Idempotency.deleteMany({ userId: user._id });
  await user.deleteOne();
}
