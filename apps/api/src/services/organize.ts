import type { ListColor, ListIcon, ListMemberDto } from "@vela/shared";
import { HttpError, isDuplicateKey } from "../http.js";
import { List, ListMember, Tag, Task, User } from "../models.js";
import { toListDto, toTagDto } from "../serialize.js";

const memberLimit = 20;

async function requireOwnedList(userId: string, listId: string) {
  const list = await List.findOne({ _id: listId, userId });
  if (!list) throw new HttpError(404, "NOT_FOUND", "List not found.");
  return list;
}

export async function listAccess(userId: string, listId: string): Promise<"owner" | "editor" | null> {
  if (!/^[a-f\d]{24}$/i.test(listId)) return null;
  const list = await List.findById(listId);
  if (!list) return null;
  if (list.userId.toString() === userId) return "owner";
  const member = await ListMember.findOne({ listId, userId, leftAt: null });
  return member ? "editor" : null;
}

export async function assertListAccess(userId: string, listId: string): Promise<"owner" | "editor"> {
  const access = await listAccess(userId, listId);
  if (!access) throw new HttpError(404, "NOT_FOUND", "List not found.");
  return access;
}

export async function accessibleListIds(userId: string) {
  const [owned, shared] = await Promise.all([
    List.find({ userId }).select("_id"),
    ListMember.find({ userId, leftAt: null }).select("listId"),
  ]);
  return [...owned.map((list) => list._id), ...shared.map((member) => member.listId)];
}

export async function listLists(userId: string) {
  const own = await List.find({ userId }).sort({ sortOrder: 1, name: 1 });
  const memberships = await ListMember.find({ userId, leftAt: null });
  const shared = await List.find({ _id: { $in: memberships.map((member) => member.listId) } }).sort({ name: 1 });
  return [...own.map((list) => toListDto(list, "owner")), ...shared.map((list) => toListDto(list, "editor"))];
}

export async function createList(userId: string, input: { name: string; color: ListColor; icon: ListIcon }) {
  const last = await List.findOne({ userId }).sort({ sortOrder: -1 });
  const list = await List.create({
    userId,
    name: input.name,
    color: input.color,
    icon: input.icon,
    sortOrder: (last?.sortOrder ?? 0) + 1,
    isInbox: false,
  });
  return toListDto(list, "owner");
}

export async function reorderLists(userId: string, ids: string[]): Promise<void> {
  const owned = await List.find({ userId });
  const inbox = owned.find((list) => list.isInbox);
  if (!inbox) throw new HttpError(500, "INBOX_MISSING", "Inbox is missing.");
  if (ids.includes(inbox._id.toString())) throw new HttpError(400, "INBOX_FIXED", "Inbox stays first.");
  const movable = owned.filter((list) => !list.isInbox);
  const unique = new Set(ids);
  if (unique.size !== ids.length || ids.length !== movable.length) {
    throw new HttpError(400, "LIST_ORDER", "Send every list except Inbox.");
  }
  const movableIds = new Set(movable.map((list) => list._id.toString()));
  if (ids.some((id) => !movableIds.has(id))) throw new HttpError(404, "NOT_FOUND", "One or more lists were not found.");
  if (inbox.sortOrder !== 0) {
    inbox.sortOrder = 0;
    await inbox.save();
  }
  const current = [...movable].sort((left, right) => left.sortOrder - right.sortOrder);
  const writes = ids.flatMap((id, index) => {
    const sortOrder = index + 1;
    const list = current[index];
    if (list?._id.toString() === id && list.sortOrder === sortOrder) return [];
    return [
      {
        updateOne: {
          filter: { _id: id, userId },
          update: { $set: { sortOrder } },
        },
      },
    ];
  });
  if (writes.length === 0) return;
  await List.bulkWrite(writes);
}

export async function updateList(
  userId: string,
  listId: string,
  input: { name?: string; color?: ListColor; icon?: ListIcon; archived?: boolean },
) {
  const access = await listAccess(userId, listId);
  if (!access) throw new HttpError(404, "NOT_FOUND", "List not found.");
  if (access !== "owner") throw new HttpError(403, "LIST_OWNER", "Only the list owner can change the list.");
  const list = await requireOwnedList(userId, listId);
  if (input.name !== undefined && input.name !== list.name) {
    if (list.isInbox) throw new HttpError(400, "INBOX_NAME", "Inbox keeps its name.");
    list.name = input.name;
  }
  if (input.color !== undefined && input.color !== list.color) list.color = input.color;
  if (input.icon !== undefined && input.icon !== list.icon) list.icon = input.icon;
  if (input.archived !== undefined) {
    if (list.isInbox && input.archived) throw new HttpError(400, "INBOX_VISIBLE", "Inbox stays in the sidebar.");
    if (input.archived !== Boolean(list.archivedAt)) list.archivedAt = input.archived ? new Date() : null;
  }
  if (!list.isModified()) return toListDto(list, "owner");
  await list.save();
  return toListDto(list, "owner");
}

export async function deleteList(userId: string, listId: string): Promise<void> {
  const access = await listAccess(userId, listId);
  if (!access) throw new HttpError(404, "NOT_FOUND", "List not found.");
  if (access !== "owner") throw new HttpError(403, "LIST_OWNER", "Only the list owner can delete the list.");
  const list = await requireOwnedList(userId, listId);
  if (list.isInbox) throw new HttpError(400, "INBOX_PERMANENT", "Inbox cannot be deleted.");
  const tasks = await Task.find({ listId: list._id });
  for (const task of tasks) {
    const inbox = await List.findOne({ userId: task.userId, isInbox: true });
    if (!inbox) throw new HttpError(500, "INBOX_MISSING", "Inbox is missing.");
    task.listId = inbox._id;
    await task.save();
  }
  await ListMember.deleteMany({ listId: list._id });
  await list.deleteOne();
}

export async function listMembers(userId: string, listId: string): Promise<ListMemberDto[]> {
  if (!(await listAccess(userId, listId))) throw new HttpError(404, "NOT_FOUND", "List not found.");
  const list = await List.findById(listId);
  if (!list) throw new HttpError(404, "NOT_FOUND", "List not found.");
  const owner = await User.findById(list.userId);
  if (!owner) throw new HttpError(500, "OWNER_MISSING", "The list owner is missing.");
  const memberships = await ListMember.find({ listId, leftAt: null });
  const editors = await User.find({ _id: { $in: memberships.map((member) => member.userId) } });
  return [
    { id: owner._id.toString(), email: owner.email, role: "owner" },
    ...editors.map((editor) => ({ id: editor._id.toString(), email: editor.email, role: "editor" as const })),
  ];
}

export async function shareList(userId: string, listId: string, email: string): Promise<ListMemberDto & { added: boolean }> {
  const list = await requireOwnedList(userId, listId);
  if (list.isInbox) throw new HttpError(400, "INBOX_PRIVATE", "Inbox cannot be shared.");
  const account = await User.findOne({ email: email.trim().toLowerCase() });
  if (!account) throw new HttpError(404, "NO_ACCOUNT", "No KeepX account uses that email.");
  if (account._id.equals(list.userId)) throw new HttpError(400, "SELF_SHARE", "You already own this list.");
  const existing = await ListMember.findOne({ listId, userId: account._id });
  if (existing && !existing.leftAt) return { id: account._id.toString(), email: account.email, role: "editor", added: false };
  if (existing?.leftAt) {
    existing.leftAt = null;
    await existing.save();
    return { id: account._id.toString(), email: account.email, role: "editor", added: true };
  }
  if ((await ListMember.countDocuments({ listId, leftAt: null })) >= memberLimit) {
    throw new HttpError(400, "MEMBER_LIMIT", "This list already has 20 people.");
  }
  await ListMember.create({ listId, userId: account._id, leftAt: null });
  return { id: account._id.toString(), email: account.email, role: "editor", added: true };
}

export async function removeMember(userId: string, listId: string, memberId: string): Promise<void> {
  const access = await listAccess(userId, listId);
  if (!access) throw new HttpError(404, "NOT_FOUND", "List not found.");
  if (!/^[a-f\d]{24}$/i.test(memberId)) throw new HttpError(404, "NOT_FOUND", "That person is not on this list.");
  const list = await List.findById(listId);
  if (!list || list.userId.toString() === memberId) {
    throw new HttpError(400, "OWNER_STAYS", "The owner stays on the list.");
  }
  if (access !== "owner" && memberId !== userId) {
    throw new HttpError(403, "LIST_OWNER", "Only the list owner can remove someone else.");
  }
  const leavingSelf = memberId === userId;
  if (leavingSelf) {
    const left = await ListMember.findOneAndUpdate(
      { listId, userId: memberId, leftAt: null },
      { $set: { leftAt: new Date() } },
    );
    if (!left) throw new HttpError(404, "NOT_FOUND", "That person is not on this list.");
  } else {
    const removed = await ListMember.findOneAndDelete({ listId, userId: memberId });
    if (!removed) throw new HttpError(404, "NOT_FOUND", "That person is not on this list.");
  }
  await Task.updateMany({ listId, assigneeId: memberId }, { $set: { assigneeId: null }, $inc: { revision: 1 } });
}

export async function rejoinList(userId: string, listId: string): Promise<ListMemberDto> {
  if (!/^[a-f\d]{24}$/i.test(listId)) throw new HttpError(404, "NOT_FOUND", "List not found.");
  const list = await List.findById(listId);
  if (!list) throw new HttpError(404, "NOT_FOUND", "List not found.");
  if (list.userId.toString() === userId) throw new HttpError(400, "SELF_SHARE", "You already own this list.");
  const membership = await ListMember.findOne({ listId, userId });
  if (!membership?.leftAt) throw new HttpError(404, "NOT_FOUND", "You have not left this list.");
  if ((await ListMember.countDocuments({ listId, leftAt: null })) >= memberLimit) {
    throw new HttpError(400, "MEMBER_LIMIT", "This list already has 20 people.");
  }
  membership.leftAt = null;
  await membership.save();
  const account = await User.findById(userId);
  if (!account) throw new HttpError(404, "NOT_FOUND", "Account not found.");
  return { id: account._id.toString(), email: account.email, role: "editor" };
}

export async function inboxId(userId: string) {
  const inbox = await List.findOne({ userId, isInbox: true });
  if (!inbox) throw new HttpError(500, "INBOX_MISSING", "Inbox is missing.");
  return inbox._id;
}

export async function assertOwnedList(userId: string, listId: string) {
  await requireOwnedList(userId, listId);
}

export async function listTags(userId: string) {
  const tags = await Tag.find({ userId }).sort({ name: 1 });
  return tags.map((tag) => toTagDto(tag));
}

export async function createTag(userId: string, input: { name: string; color: ListColor }) {
  try {
    const tag = await Tag.create({ userId, name: input.name, color: input.color });
    return toTagDto(tag);
  } catch (error) {
    if (isDuplicateKey(error)) throw new HttpError(409, "TAG_EXISTS", "You already have a tag with that name.");
    throw error;
  }
}

export async function updateTag(userId: string, tagId: string, input: { name?: string; color?: ListColor }) {
  const tag = await Tag.findOne({ _id: tagId, userId });
  if (!tag) throw new HttpError(404, "NOT_FOUND", "Tag not found.");
  const name = input.name ?? tag.name;
  const color = input.color ?? tag.color;
  if (name === tag.name && color === tag.color) return toTagDto(tag);
  tag.name = name;
  tag.color = color;
  try {
    await tag.save();
  } catch (error) {
    if (isDuplicateKey(error)) throw new HttpError(409, "TAG_EXISTS", "You already have a tag with that name.");
    throw error;
  }
  return toTagDto(tag);
}

export async function deleteTag(userId: string, tagId: string): Promise<void> {
  const tag = await Tag.findOneAndDelete({ _id: tagId, userId });
  if (!tag) throw new HttpError(404, "NOT_FOUND", "Tag not found.");
  await Task.updateMany({ tagIds: tag._id }, { $pull: { tagIds: tag._id } });
}

export async function assertOwnedTags(userId: string, tagIds: string[]): Promise<void> {
  if (tagIds.length === 0) return;
  const count = await Tag.countDocuments({ userId, _id: { $in: tagIds } });
  if (count !== tagIds.length) throw new HttpError(400, "UNKNOWN_TAG", "One or more tags are not in your workspace.");
}
