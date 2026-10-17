import type { AccountExportDto, ListMemberDto } from "@vela/shared";
import { HttpError } from "../http.js";
import { List, ListMember, Occurrence, Task, User, type TaskRecord } from "../models.js";
import { toListDto, toOccurrenceDto, toTaskDto } from "../serialize.js";
import { listTags } from "./organize.js";

const EXPORT_LIMIT = 5000;

export async function exportAccount(userId: string): Promise<AccountExportDto> {
  const user = await User.findById(userId);
  if (!user) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
  const [owned, memberships] = await Promise.all([List.find({ userId }).sort({ sortOrder: 1, name: 1 }), ListMember.find({ userId })]);
  const shared = await List.find({ _id: { $in: memberships.map((member) => member.listId) } }).sort({ name: 1 });
  const lists = [...owned, ...shared];
  const listIds = lists.map((list) => list._id);
  const memberRows = await ListMember.find({ listId: { $in: listIds } });
  const people = await User.find({
    _id: { $in: [...lists.map((list) => list.userId), ...memberRows.map((row) => row.userId)] },
  }).select("email");
  const emails = new Map(people.map((person) => [person._id.toString(), person.email]));
  const visibility = { $or: [{ userId }, { listId: { $in: listIds } }] };
  const taskCount = await Task.countDocuments(visibility);
  const tasks = await Task.find(visibility).sort({ createdAt: 1 }).limit(EXPORT_LIMIT);
  const taskIds = tasks.map((task) => task._id);
  const occurrenceCount = await Occurrence.countDocuments({ taskId: { $in: taskIds } });
  const occurrences = await Occurrence.find({ taskId: { $in: taskIds } }).sort({ actedAt: 1 }).limit(EXPORT_LIMIT);
  const titles = new Map(tasks.map((task) => [task._id.toString(), task.title]));
  const tags = await listTags(userId);
  return {
    exportedAt: new Date().toISOString(),
    truncated: taskCount > tasks.length || occurrenceCount > occurrences.length,
    account: {
      email: user.email,
      name: user.name,
      timeZone: user.timeZone,
      emailReminders: Boolean(user.emailReminders),
      pushReminders: Boolean(user.pushReminders),
      plan: user.plan === "plus" ? "plus" : "personal",
    },
    lists: lists.map((list) => ({
      ...toListDto(list, list.userId.toString() === userId ? "owner" : "editor"),
      members: membersFor(list._id.toString(), list.userId.toString(), memberRows, emails),
    })),
    tags,
    tasks: tasks.map((task) => toTaskDto(task as unknown as TaskRecord)),
    occurrences: occurrences.map((row) => toOccurrenceDto(row, titles.get(row.taskId.toString()) ?? "Task")),
  };
}

function membersFor(
  listId: string,
  ownerId: string,
  rows: { listId: { toString(): string }; userId: { toString(): string } }[],
  emails: Map<string, string>,
): ListMemberDto[] {
  const ownerEmail = emails.get(ownerId);
  const members: ListMemberDto[] = ownerEmail ? [{ id: ownerId, email: ownerEmail, role: "owner" }] : [];
  for (const row of rows) {
    if (row.listId.toString() !== listId) continue;
    const id = row.userId.toString();
    const email = emails.get(id);
    if (!email) continue;
    members.push({ id, email, role: "editor" });
  }
  return members;
}
