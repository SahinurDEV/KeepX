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

export const deleteAccountSchema = z.object({
  password: z.string().min(1).max(200),
});

export const passwordResetRequestSchema = z.object({
  email: z.string().trim().email().max(200),
});

export const accessTokenSchema = z.object({
  name: z.string().trim().min(1).max(40),
});

export const passwordResetSchema = z.object({
  token: z.string().trim().min(20).max(200),
  password: z.string().min(10).max(200),
});

export const profileSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    timeZone: timeZoneSchema.optional(),
    emailReminders: z.boolean().optional(),
    pushReminders: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined || value.timeZone !== undefined || value.emailReminders !== undefined || value.pushReminders !== undefined,
    { message: "Provide a name, a time zone, or a reminder choice." },
  );

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

export const shareListSchema = z.object({
  email: z.string().trim().email().max(200),
});

const webSubscriptionSchema = z.object({
  endpoint: z
    .string()
    .url()
    .max(2000)
    .refine((value) => value.startsWith("https://"), "Use an https push endpoint."),
  keys: z.object({
    p256dh: z.string().trim().min(1).max(200),
    auth: z.string().trim().min(1).max(200),
  }),
});

export const registerDeviceSchema = z
  .object({
    platform: z.enum(["web", "android", "ios"]),
    token: z.string().trim().min(20).max(4000),
  })
  .superRefine((value, context) => {
    if (value.platform === "web") {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(value.token);
      } catch {
        parsed = null;
      }
      if (!webSubscriptionSchema.safeParse(parsed).success) {
        context.addIssue({ code: "custom", message: "The browser subscription is not valid.", path: ["token"] });
      }
      return;
    }
    if (!/^ExponentPushToken\[[A-Za-z0-9_-]{8,200}\]$/.test(value.token)) {
      context.addIssue({ code: "custom", message: "Use an Expo push token.", path: ["token"] });
    }
  });

export const snoozeReminderSchema = z
  .object({
    minutes: z.number().int().min(1).max(1440).optional(),
    fireAt: z.string().datetime().optional(),
  })
  .superRefine((value, context) => {
    if (value.minutes === undefined && value.fireAt === undefined) {
      context.addIssue({ code: "custom", message: "Choose how long to snooze, or a fire time.", path: ["minutes"] });
    }
    if (value.minutes !== undefined && value.fireAt !== undefined) {
      context.addIssue({ code: "custom", message: "Choose minutes or a fire time.", path: ["fireAt"] });
    }
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
  occurrenceScope: z.enum(["this", "following"]).optional(),
});

export const reorderSchema = z.object({
  ids: z.array(objectIdSchema).min(1).max(500),
});

export const purgeSelectedSchema = z.object({
  ids: z.array(objectIdSchema).min(1).max(100),
});

export const restoreSelectedSchema = z.object({
  ids: z.array(objectIdSchema).min(1).max(100),
});

export const sortTasksSchema = z.object({
  listId: objectIdSchema,
  by: z.enum(["due", "priority", "title"]),
});

export const batchSchema = z.object({
  ids: z.array(objectIdSchema).min(1).max(100),
  action: z.enum(["complete", "delete", "move", "priority", "due", "tag", "reopen", "remind", "postpone", "start", "estimate", "pin", "duplicate", "archive", "unarchive", "skip", "omit", "assign", "repeat", "parent"]),
  listId: objectIdSchema.optional(),
  priority: z.enum(["none", "low", "medium", "high"]).optional(),
  dueAt: z.string().datetime().nullable().optional(),
  dueHasTime: z.boolean().optional(),
  tagId: objectIdSchema.optional(),
  tagMode: z.enum(["add", "remove"]).optional(),
  reminderOffsetMinutes: z.number().int().min(0).max(525600).nullable().optional(),
  startAt: z.string().datetime().nullable().optional(),
  estimatedMinutes: z.number().int().min(0).max(100000).nullable().optional(),
  pinned: z.boolean().optional(),
  assigneeId: objectIdSchema.nullable().optional(),
  recurrence: recurrenceSchema.nullable().optional(),
  parentId: objectIdSchema.nullable().optional(),
}).superRefine((value, context) => {
  if (value.action === "move" && !value.listId) {
    context.addIssue({ code: "custom", message: "Choose a list.", path: ["listId"] });
  }
  if (value.action === "priority" && !value.priority) {
    context.addIssue({ code: "custom", message: "Choose a priority.", path: ["priority"] });
  }
  if (value.action === "due" && value.dueAt === undefined) {
    context.addIssue({ code: "custom", message: "Choose a date.", path: ["dueAt"] });
  }
  if (value.action === "tag" && (!value.tagId || !value.tagMode)) {
    context.addIssue({ code: "custom", message: "Choose a tag.", path: ["tagId"] });
  }
  if (value.action === "remind" && value.reminderOffsetMinutes === undefined) {
    context.addIssue({ code: "custom", message: "Choose a reminder.", path: ["reminderOffsetMinutes"] });
  }
  if (value.action === "start" && value.startAt === undefined) {
    context.addIssue({ code: "custom", message: "Choose a start date.", path: ["startAt"] });
  }
  if (value.action === "estimate" && value.estimatedMinutes === undefined) {
    context.addIssue({ code: "custom", message: "Choose an estimate.", path: ["estimatedMinutes"] });
  }
  if (value.action === "pin" && value.pinned === undefined) {
    context.addIssue({ code: "custom", message: "Choose whether to pin the tasks.", path: ["pinned"] });
  }
  if (value.action === "assign" && value.assigneeId === undefined) {
    context.addIssue({ code: "custom", message: "Choose who to assign.", path: ["assigneeId"] });
  }
  if (value.action === "repeat" && value.recurrence === undefined) {
    context.addIssue({ code: "custom", message: "Choose a repeat rule.", path: ["recurrence"] });
  }
  if (value.action === "parent" && value.parentId === undefined) {
    context.addIssue({ code: "custom", message: "Choose a task.", path: ["parentId"] });
  }
});

export const pinTaskSchema = z.object({ pinned: z.boolean() });

export const assignTaskSchema = z.object({
  userId: objectIdSchema.nullable(),
});

export const revertImportSchema = z.object({
  listIds: z.array(objectIdSchema).max(200),
  tagIds: z.array(objectIdSchema).max(500),
  taskIds: z.array(objectIdSchema).max(5000),
});

export const importAccountSchema = z.object({
  exportedAt: z.string().datetime(),
  truncated: z.boolean(),
  account: z.object({
    email: z.string().max(200),
    name: z.string().max(80),
    timeZone: z.string().max(80),
    emailReminders: z.boolean(),
    pushReminders: z.boolean(),
    plan: z.enum(["personal", "plus"]),
  }),
  lists: z
    .array(
      z.object({
        id: objectIdSchema,
        name: z.string().trim().min(1).max(80),
        color: z.enum(LIST_COLORS),
        icon: z.enum(LIST_ICONS),
        sortOrder: z.number().int(),
        isInbox: z.boolean(),
        archivedAt: z.string().datetime().nullable(),
        role: z.enum(["owner", "editor"]),
        members: z
          .array(z.object({ id: z.string().max(40), email: z.string().max(200), role: z.enum(["owner", "editor"]) }))
          .max(21),
      }),
    )
    .max(200),
  tags: z.array(z.object({ id: objectIdSchema, name: z.string().trim().min(1).max(40), color: z.enum(LIST_COLORS) })).max(500),
  tasks: z
    .array(
      taskFieldsSchema.extend({
        id: objectIdSchema,
        title: z.string().trim().min(1).max(500),
        description: z.string().max(20000),
        status: z.enum(["open", "completed", "archived"]),
        listId: objectIdSchema,
        parentId: objectIdSchema.nullable(),
        tagIds: z.array(objectIdSchema).max(20),
        dueAt: z.string().datetime().nullable(),
        dueHasTime: z.boolean(),
        startAt: z.string().datetime().nullable(),
        priority: z.enum(["none", "low", "medium", "high"]),
        timeZone: timeZoneSchema,
        estimatedMinutes: z.number().int().min(0).max(100000).nullable(),
        reminderOffsetMinutes: z.number().int().min(0).max(525600).nullable(),
        recurrence: recurrenceSchema.nullable(),
        sortOrder: z.number().int(),
        pinned: z.boolean().optional().default(false),
        completedAt: z.string().datetime().nullable(),
        deletedAt: z.string().datetime().nullable(),
        createdAt: z.string().datetime(),
        updatedAt: z.string().datetime(),
        revision: z.number().int().min(0),
        anchorAt: z.string().datetime().nullable(),
        occurrenceOriginalDueAt: z.string().datetime().nullable(),
      }),
    )
    .max(5000),
  occurrences: z
    .array(
      z.object({
        id: objectIdSchema,
        taskId: objectIdSchema,
        title: z.string().max(500),
        action: z.enum(["completed", "skipped"]),
        occurrenceDueAt: z.string().datetime(),
        actedAt: z.string().datetime(),
      }),
    )
    .max(5000),
});

export const taskQuerySchema = z.object({
  view: z
    .enum(["inbox", "today", "upcoming", "all", "completed", "list", "tag", "calendar", "archived", "search", "trash"])
    .default("all"),
  listId: objectIdSchema.optional(),
  tagId: objectIdSchema.optional(),
  q: z.string().trim().max(200).optional(),
  priority: z.enum(["none", "low", "medium", "high"]).optional(),
  due: z.enum(["none", "overdue"]).optional(),
  started: z.enum(["waiting"]).optional(),
  pinned: z.enum(["true"]).optional(),
  assignee: z.enum(["me"]).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  topLevel: z.enum(["true", "false"]).optional(),
});

export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);
