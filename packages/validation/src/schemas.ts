import { LIST_COLORS, LIST_ICONS } from "@vela/shared";
import { z } from "zod";

export const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Expected an id");

const timeZoneSchema = z.string().trim().min(1).max(80);

export const registerSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(200),
  password: z.string().min(10).max(200),
  timeZone: timeZoneSchema.optional(),
});

export const loginSchema = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(1).max(200),
});

export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(10).max(200),
});

export const profileSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    timeZone: timeZoneSchema.optional(),
  })
  .refine((value) => value.name !== undefined || value.timeZone !== undefined, {
    message: "Provide a name or a time zone.",
  });

export const recurrenceSchema = z
  .object({
    frequency: z.enum(["daily", "weekly", "monthly", "yearly"]),
    interval: z.number().int().min(1).max(99),
    byWeekday: z.array(z.number().int().min(1).max(7)).max(7).optional(),
    until: z.string().datetime().optional(),
    count: z.number().int().min(1).max(999).optional(),
  })
  .superRefine((value, context) => {
    if (!value.byWeekday) return;
    if (new Set(value.byWeekday).size !== value.byWeekday.length) {
      context.addIssue({ code: "custom", message: "Weekdays must be unique.", path: ["byWeekday"] });
    }
  });

export const createListSchema = z.object({
  name: z.string().trim().min(1).max(80),
  color: z.enum(LIST_COLORS).default("clay"),
  icon: z.enum(LIST_ICONS).default("star"),
});

export const updateListSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  color: z.enum(LIST_COLORS).optional(),
  icon: z.enum(LIST_ICONS).optional(),
  archived: z.boolean().optional(),
});

export const createTagSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: z.enum(LIST_COLORS).default("sea"),
});

export const updateTagSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  color: z.enum(LIST_COLORS).optional(),
});

export const taskFieldsSchema = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().max(20000).optional(),
  listId: objectIdSchema.optional(),
  parentId: objectIdSchema.nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  dueHasTime: z.boolean().optional(),
  startAt: z.string().datetime().nullable().optional(),
  timeZone: timeZoneSchema.optional(),
  priority: z.enum(["none", "low", "medium", "high"]).optional(),
  tagIds: z.array(objectIdSchema).max(20).optional(),
  estimatedMinutes: z.number().int().min(0).max(100000).nullable().optional(),
  reminderOffsetMinutes: z.number().int().min(0).max(525600).nullable().optional(),
  recurrence: recurrenceSchema.nullable().optional(),
});

export const createTaskSchema = taskFieldsSchema;
export const updateTaskSchema = taskFieldsSchema.partial().extend({
  revision: z.number().int().min(0),
});

export const reorderSchema = z.object({
  ids: z.array(objectIdSchema).min(1).max(500),
});

export const batchSchema = z.object({
  ids: z.array(objectIdSchema).min(1).max(100),
  action: z.enum(["complete", "delete"]),
  listId: objectIdSchema.optional(),
});

export const taskQuerySchema = z.object({
  view: z
    .enum(["inbox", "today", "upcoming", "all", "completed", "list", "tag", "calendar", "archived", "search"])
    .default("all"),
  listId: objectIdSchema.optional(),
  tagId: objectIdSchema.optional(),
  q: z.string().trim().max(200).optional(),
  priority: z.enum(["none", "low", "medium", "high"]).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  topLevel: z.enum(["true", "false"]).optional(),
});

export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);
