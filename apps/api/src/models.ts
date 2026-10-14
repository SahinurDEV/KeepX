import mongoose, { Schema, type Types } from "mongoose";
import type { ListColor, ListIcon, Priority, TaskStatus } from "@vela/shared";

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, index: true },
    passwordHash: { type: String, required: true },
    name: { type: String, required: true },
    timeZone: { type: String, required: true },
  },
  { timestamps: true },
);

const sessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true, ref: "User" },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    userAgent: { type: String, default: "" },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const listSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    name: { type: String, required: true },
    color: { type: String, required: true },
    icon: { type: String, required: true },
    sortOrder: { type: Number, required: true },
    isInbox: { type: Boolean, required: true, default: false },
    archivedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
listSchema.index({ userId: 1, isInbox: 1 });

const tagSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    name: { type: String, required: true },
    color: { type: String, required: true },
  },
  { timestamps: true },
);
tagSchema.index({ userId: 1, name: 1 }, { unique: true });

const recurrenceSchema = new Schema(
  {
    frequency: { type: String, required: true, enum: ["daily", "weekly", "monthly", "yearly"] },
    interval: { type: Number, required: true },
    byWeekday: { type: [Number], required: false },
    until: { type: Date, required: false },
    count: { type: Number, required: false },
  },
  { _id: false },
);

const taskSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    listId: { type: Schema.Types.ObjectId, required: true },
    parentId: { type: Schema.Types.ObjectId, default: null },
    title: { type: String, required: true },
    description: { type: String, default: "" },
    status: { type: String, required: true, enum: ["open", "completed", "archived"] },
    dueAt: { type: Date, default: null },
    dueHasTime: { type: Boolean, default: false },
    startAt: { type: Date, default: null },
    timeZone: { type: String, required: true },
    priority: { type: String, required: true, enum: ["none", "low", "medium", "high"] },
    tagIds: { type: [Schema.Types.ObjectId], default: [] },
    estimatedMinutes: { type: Number, default: null },
    reminderOffsetMinutes: { type: Number, default: null },
    recurrence: { type: recurrenceSchema, default: null },
    anchorAt: { type: Date, default: null },
    seriesId: { type: Schema.Types.ObjectId, required: true },
    sortOrder: { type: Number, required: true },
    revision: { type: Number, required: true, default: 0 },
    completedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
taskSchema.index({ userId: 1, deletedAt: 1, status: 1, dueAt: 1 });
taskSchema.index({ userId: 1, listId: 1, sortOrder: 1 });
taskSchema.index({ userId: 1, parentId: 1 });

const occurrenceSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    taskId: { type: Schema.Types.ObjectId, required: true, index: true },
    seriesId: { type: Schema.Types.ObjectId, required: true },
    occurrenceDueAt: { type: Date, required: true },
    action: { type: String, required: true, enum: ["completed", "skipped"] },
    actedAt: { type: Date, required: true },
  },
  { timestamps: false },
);
occurrenceSchema.index({ taskId: 1, occurrenceDueAt: 1, action: 1 }, { unique: true });

const reminderSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    taskId: { type: Schema.Types.ObjectId, required: true, index: true },
    fireAt: { type: Date, required: true },
    channel: { type: String, required: true, enum: ["in_app"] },
    status: { type: String, required: true, enum: ["scheduled", "delivered", "cancelled"] },
    deliveredAt: { type: Date, default: null },
  },
  { timestamps: true },
);

const idempotencySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    key: { type: String, required: true },
    requestHash: { type: String, required: true },
    statusCode: { type: Number, required: true },
    responseBody: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
idempotencySchema.index({ userId: 1, key: 1 }, { unique: true });
idempotencySchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 });

export const User = mongoose.model("User", userSchema);
export const Session = mongoose.model("Session", sessionSchema);
export const List = mongoose.model("List", listSchema);
export const Tag = mongoose.model("Tag", tagSchema);
export const Task = mongoose.model("Task", taskSchema);
export const Occurrence = mongoose.model("Occurrence", occurrenceSchema);
export const Reminder = mongoose.model("Reminder", reminderSchema);
export const Idempotency = mongoose.model("Idempotency", idempotencySchema);

export interface TaskRecord {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  listId: Types.ObjectId;
  parentId: Types.ObjectId | null;
  title: string;
  description: string;
  status: TaskStatus;
  dueAt: Date | null;
  dueHasTime: boolean;
  startAt: Date | null;
  timeZone: string;
  priority: Priority;
  tagIds: Types.ObjectId[];
  estimatedMinutes: number | null;
  reminderOffsetMinutes: number | null;
  recurrence: {
    frequency: "daily" | "weekly" | "monthly" | "yearly";
    interval: number;
    byWeekday?: number[] | null;
    until?: Date | null;
    count?: number | null;
  } | null;
  anchorAt: Date | null;
  seriesId: Types.ObjectId;
  sortOrder: number;
  revision: number;
  completedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ListColorValue = ListColor;
export type ListIconValue = ListIcon;
