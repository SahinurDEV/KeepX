export const APP_VERSION = "0.1.0";
export const DEFAULT_APP_NAME = "Vela";
export const INTERNAL_CODENAME = "Orbit";

export const LIST_COLORS = ["clay", "sea", "plum", "moss", "gold", "slate", "rose", "sky"] as const;
export const LIST_ICONS = [
  "inbox",
  "home",
  "briefcase",
  "book",
  "heart",
  "star",
  "flag",
  "sun",
  "moon",
  "gift",
  "music",
  "code",
  "plane",
] as const;

export type ListColor = (typeof LIST_COLORS)[number];
export type ListIcon = (typeof LIST_ICONS)[number];
export type Priority = "none" | "low" | "medium" | "high";
export type TaskStatus = "open" | "completed" | "archived";
export type RecurrenceFrequency = "daily" | "weekly" | "monthly" | "yearly";
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface RecurrenceRule {
  frequency: RecurrenceFrequency;
  interval: number;
  byWeekday?: number[];
  until?: string;
  count?: number;
}

export interface UserDto {
  id: string;
  email: string;
  name: string;
  timeZone: string;
  createdAt: string;
}

export interface ListDto {
  id: string;
  name: string;
  color: ListColor;
  icon: ListIcon;
  sortOrder: number;
  isInbox: boolean;
  archivedAt: string | null;
}

export interface TagDto {
  id: string;
  name: string;
  color: ListColor;
}

export interface TaskDto {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  dueAt: string | null;
  dueHasTime: boolean;
  startAt: string | null;
  timeZone: string;
  priority: Priority;
  listId: string;
  tagIds: string[];
  estimatedMinutes: number | null;
  reminderOffsetMinutes: number | null;
  recurrence: RecurrenceRule | null;
  anchorAt: string | null;
  parentId: string | null;
  sortOrder: number;
  completedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface OccurrenceDto {
  id: string;
  taskId: string;
  title: string;
  action: "completed" | "skipped";
  occurrenceDueAt: string;
  actedAt: string;
}

export interface ReminderDto {
  id: string;
  taskId: string;
  title: string;
  fireAt: string;
  status: "scheduled" | "delivered" | "cancelled";
  channel: "in_app";
}

export interface MetaDto {
  appName: string;
  version: string;
  emailRecovery: false;
  notificationChannels: ["in_app"];
  billing: false;
}

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: { path: string; message: string }[];
    requestId?: string;
  };
}

export interface TaskListResponse {
  tasks: TaskDto[];
  occurrences?: OccurrenceDto[];
  truncated: boolean;
}
