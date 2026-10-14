import type { ListColor, ListIcon } from "@vela/shared";
import { HttpError, isDuplicateKey } from "../http.js";
import { List, Tag, Task } from "../models.js";
import { toListDto, toTagDto } from "../serialize.js";

async function requireList(userId: string, listId: string) {
  const list = await List.findOne({ _id: listId, userId });
  if (!list) throw new HttpError(404, "NOT_FOUND", "List not found.");
  return list;
}

export async function listLists(userId: string) {
  const lists = await List.find({ userId }).sort({ sortOrder: 1, name: 1 });
  return lists.map((list) => toListDto(list));
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
  return toListDto(list);
}

export async function updateList(
  userId: string,
  listId: string,
  input: { name?: string; color?: ListColor; icon?: ListIcon; archived?: boolean },
) {
  const list = await requireList(userId, listId);
  if (input.name !== undefined) list.name = input.name;
  if (input.color !== undefined) list.color = input.color;
  if (input.icon !== undefined) list.icon = input.icon;
  if (input.archived !== undefined) list.archivedAt = input.archived ? new Date() : null;
  await list.save();
  return toListDto(list);
}

export async function deleteList(userId: string, listId: string): Promise<void> {
  const list = await requireList(userId, listId);
  if (list.isInbox) throw new HttpError(400, "INBOX_PERMANENT", "Inbox cannot be deleted.");
  const inbox = await List.findOne({ userId, isInbox: true });
  if (!inbox) throw new HttpError(500, "INBOX_MISSING", "Inbox is missing.");
  await Task.updateMany({ userId, listId: list._id }, { $set: { listId: inbox._id } });
  await list.deleteOne();
}

export async function inboxId(userId: string) {
  const inbox = await List.findOne({ userId, isInbox: true });
  if (!inbox) throw new HttpError(500, "INBOX_MISSING", "Inbox is missing.");
  return inbox._id;
}

export async function assertOwnedList(userId: string, listId: string) {
  await requireList(userId, listId);
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
  try {
    const tag = await Tag.findOneAndUpdate({ _id: tagId, userId }, { $set: input }, { new: true });
    if (!tag) throw new HttpError(404, "NOT_FOUND", "Tag not found.");
    return toTagDto(tag);
  } catch (error) {
    if (isDuplicateKey(error)) throw new HttpError(409, "TAG_EXISTS", "You already have a tag with that name.");
    throw error;
  }
}

export async function deleteTag(userId: string, tagId: string): Promise<void> {
  const tag = await Tag.findOneAndDelete({ _id: tagId, userId });
  if (!tag) throw new HttpError(404, "NOT_FOUND", "Tag not found.");
  await Task.updateMany({ userId, tagIds: tag._id }, { $pull: { tagIds: tag._id } });
}

export async function assertOwnedTags(userId: string, tagIds: string[]): Promise<void> {
  if (tagIds.length === 0) return;
  const count = await Tag.countDocuments({ userId, _id: { $in: tagIds } });
  if (count !== tagIds.length) throw new HttpError(400, "UNKNOWN_TAG", "One or more tags are not in your workspace.");
}
