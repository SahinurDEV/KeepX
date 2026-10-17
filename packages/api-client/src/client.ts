import type {
  AccountExportDto,
  AccountImportResult,
  EntitlementDto,
  ErrorBody,
  ListDto,
  ListMemberDto,
  MetaDto,
  Priority,
  RecurrenceRule,
  PushDeviceDto,
  ReminderDto,
  SessionDto,
  TagDto,
  TaskDto,
  TaskListResponse,
  UserDto,
} from "@vela/shared";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: { path: string; message: string }[],
    public task?: TaskDto,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiClient {
  meta: () => Promise<MetaDto>;
  register: (body: { name: string; email: string; password: string; timeZone?: string }) => Promise<UserDto>;
  login: (body: { email: string; password: string }) => Promise<UserDto>;
  logout: () => Promise<void>;
  me: () => Promise<UserDto>;
  updateProfile: (body: { name?: string; timeZone?: string; emailReminders?: boolean; pushReminders?: boolean }) => Promise<UserDto>;
  changePassword: (body: { currentPassword: string; newPassword: string }) => Promise<void>;
  restorePassword: () => Promise<void>;
  deleteAccount: (body: { password: string }) => Promise<void>;
  requestRecovery: (body: { email: string }) => Promise<void>;
  resetPassword: (body: { token: string; password: string }) => Promise<void>;
  accessTokens: () => Promise<{ id: string; name: string; createdAt: string }[]>;
  createAccessToken: (body: { name: string }) => Promise<{ id: string; name: string; token: string; createdAt: string }>;
  deleteAccessToken: (id: string) => Promise<void>;
  restoreAccessToken: (id: string) => Promise<{ id: string; name: string; createdAt: string }>;
  sessions: () => Promise<SessionDto[]>;
  revokeSession: (id: string) => Promise<void>;
  restoreSession: (id: string) => Promise<SessionDto>;
  lists: () => Promise<ListDto[]>;
  createList: (body: { name: string; color?: string; icon?: string }) => Promise<ListDto>;
  updateList: (id: string, body: { name?: string; color?: string; icon?: string; archived?: boolean }) => Promise<ListDto>;
  deleteList: (id: string) => Promise<void>;
  duplicateList: (id: string) => Promise<ListDto & { copiedTasks: number }>;
  reorderLists: (ids: string[]) => Promise<void>;
  listMembers: (id: string) => Promise<ListMemberDto[]>;
  shareList: (id: string, body: { email: string }) => Promise<ListMemberDto & { added: boolean }>;
  removeMember: (id: string, memberId: string) => Promise<void>;
  rejoinList: (id: string) => Promise<ListMemberDto>;
  tags: () => Promise<TagDto[]>;
  createTag: (body: { name: string; color?: string }) => Promise<TagDto>;
  updateTag: (id: string, body: { name?: string; color?: string }) => Promise<TagDto>;
  deleteTag: (id: string) => Promise<void>;
  listTasks: (query: Record<string, string | undefined>) => Promise<TaskListResponse>;
  getTask: (id: string) => Promise<{ task: TaskDto; subtasks: TaskDto[] }>;
  createTask: (body: Record<string, unknown>, idempotencyKey: string) => Promise<TaskDto>;
  duplicateTask: (id: string) => Promise<TaskDto>;
  postponeTask: (id: string) => Promise<TaskDto>;
  pinTask: (id: string, pinned: boolean) => Promise<TaskDto>;
  assignTask: (id: string, userId: string | null) => Promise<TaskDto>;
  updateTask: (id: string, body: Record<string, unknown>) => Promise<TaskDto>;
  deleteTask: (id: string) => Promise<void>;
  restoreTask: (id: string) => Promise<TaskDto>;
  restoreSelected: (ids: string[]) => Promise<{ restored: number; skipped: number; tasks: TaskDto[] }>;
  purgeTask: (id: string) => Promise<{ deletedIds: string[]; detachedIds: string[] }>;
  purgeSelected: (ids: string[]) => Promise<{ purged: number; kept: number; deletedIds: string[]; detachedIds: string[] }>;
  restorePurged: (ids: string[]) => Promise<{ restored: number }>;
  emptyTrash: () => Promise<{ purged: number; kept: number; deletedIds: string[] }>;
  clearCompleted: () => Promise<{ deleted: number; kept: number; deletedIds: string[] }>;
  completeTask: (id: string) => Promise<TaskDto>;
  finishSubtasks: (id: string) => Promise<TaskDto>;
  uncompleteTask: (id: string) => Promise<TaskDto>;
  skipTask: (id: string) => Promise<TaskDto>;
  omitOccurrence: (id: string) => Promise<TaskDto>;
  restoreOmittedOccurrence: (id: string) => Promise<TaskDto>;
  archiveTask: (id: string) => Promise<TaskDto>;
  unarchiveTask: (id: string) => Promise<TaskDto>;
  reorderTasks: (ids: string[]) => Promise<void>;
  sortTasks: (body: { listId: string; by: "due" | "priority" | "title" }) => Promise<void>;
  batchTasks: (body: {
    ids: string[];
    action: "complete" | "delete" | "move" | "priority" | "due" | "tag" | "reopen" | "remind" | "postpone" | "start" | "estimate" | "pin" | "duplicate" | "archive" | "unarchive" | "skip" | "omit" | "assign" | "repeat" | "parent";
    listId?: string;
    priority?: Priority;
    dueAt?: string | null;
    dueHasTime?: boolean;
    tagId?: string;
    tagMode?: "add" | "remove";
    reminderOffsetMinutes?: number | null;
    startAt?: string | null;
    estimatedMinutes?: number | null;
    pinned?: boolean;
    assigneeId?: string | null;
    recurrence?: RecurrenceRule | null;
    parentId?: string | null;
  }) => Promise<{ tasks: TaskDto[] }>;
  devices: () => Promise<PushDeviceDto[]>;
  registerDevice: (body: { platform: "web" | "android" | "ios"; token: string }) => Promise<PushDeviceDto>;
  deleteDevice: (id: string) => Promise<{ platform: "web" | "android" | "ios"; token: string }>;
  billing: () => Promise<EntitlementDto>;
  startCheckout: () => Promise<{ url: string }>;
  exportAccount: () => Promise<AccountExportDto>;
  importAccount: (body: AccountExportDto) => Promise<AccountImportResult>;
  revertImport: (body: { listIds: string[]; tagIds: string[]; taskIds: string[] }) => Promise<{ lists: number; tags: number; tasks: number }>;
  pendingReminders: () => Promise<ReminderDto[]>;
  ackReminder: (id: string) => Promise<void>;
  unackReminder: (id: string) => Promise<void>;
  snoozeReminder: (id: string, body: { minutes?: number; fireAt?: string }) => Promise<ReminderDto>;
}

export interface ApiClientOptions {
  token?: () => string | null | undefined;
}

export function createApiClient(baseUrl = "", options?: ApiClientOptions): ApiClient {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    const token = options?.token?.();
    if (token) headers.set("authorization", `Bearer ${token}`);
    if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers,
      credentials: "include",
    });
    if (response.status === 204) return undefined as T;
    const payload = (await response.json().catch(() => null)) as (T & ErrorBody) | null;
    if (!response.ok) {
      const error = payload && "error" in payload ? payload.error : undefined;
      throw new ApiError(
        response.status,
        error?.code ?? "REQUEST_FAILED",
        error?.message ?? "The request failed.",
        error?.details,
        error?.task,
      );
    }
    return payload as T;
  }

  function queryString(query: Record<string, string | undefined>): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value) params.set(key, value);
    }
    const text = params.toString();
    return text ? `?${text}` : "";
  }

  return {
    meta: () => request("/api/v1/meta"),
    register: (body) => request("/api/v1/auth/register", { method: "POST", body: JSON.stringify(body) }),
    login: (body) => request("/api/v1/auth/login", { method: "POST", body: JSON.stringify(body) }),
    logout: () => request("/api/v1/auth/logout", { method: "POST" }),
    me: () => request("/api/v1/me"),
    updateProfile: (body) => request("/api/v1/me", { method: "PATCH", body: JSON.stringify(body) }),
    changePassword: (body) =>
      request("/api/v1/auth/password", { method: "POST", body: JSON.stringify(body) }),
    restorePassword: () => request("/api/v1/auth/password/restore", { method: "POST" }),
    deleteAccount: (body) => request("/api/v1/me", { method: "DELETE", body: JSON.stringify(body) }),
    requestRecovery: (body) =>
      request("/api/v1/auth/recovery", { method: "POST", body: JSON.stringify(body) }),
    resetPassword: (body) =>
      request("/api/v1/auth/reset", { method: "POST", body: JSON.stringify(body) }),
    accessTokens: () => request("/api/v1/auth/tokens"),
    createAccessToken: (body) =>
      request("/api/v1/auth/tokens", { method: "POST", body: JSON.stringify(body) }),
    deleteAccessToken: (id) => request(`/api/v1/auth/tokens/${id}`, { method: "DELETE" }),
    restoreAccessToken: (id) => request(`/api/v1/auth/tokens/${id}/restore`, { method: "POST" }),
    sessions: () => request("/api/v1/auth/sessions"),
    revokeSession: (id) => request(`/api/v1/auth/sessions/${id}`, { method: "DELETE" }),
    restoreSession: (id) => request(`/api/v1/auth/sessions/${id}/restore`, { method: "POST" }),
    lists: () => request("/api/v1/lists"),
    createList: (body) => request("/api/v1/lists", { method: "POST", body: JSON.stringify(body) }),
    updateList: (id, body) => request(`/api/v1/lists/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    deleteList: (id) => request(`/api/v1/lists/${id}`, { method: "DELETE" }),
    duplicateList: (id) => request<ListDto & { copiedTasks: number }>(`/api/v1/lists/${id}/duplicate`, { method: "POST" }),
    reorderLists: (ids) => request("/api/v1/lists/reorder", { method: "POST", body: JSON.stringify({ ids }) }),
    listMembers: (id) => request(`/api/v1/lists/${id}/members`),
    shareList: (id, body) =>
      request<ListMemberDto & { added: boolean }>(`/api/v1/lists/${id}/members`, { method: "POST", body: JSON.stringify(body) }),
    removeMember: (id, memberId) => request(`/api/v1/lists/${id}/members/${memberId}`, { method: "DELETE" }),
    rejoinList: (id) => request(`/api/v1/lists/${id}/rejoin`, { method: "POST" }),
    tags: () => request("/api/v1/tags"),
    createTag: (body) => request("/api/v1/tags", { method: "POST", body: JSON.stringify(body) }),
    updateTag: (id, body) => request(`/api/v1/tags/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    deleteTag: (id) => request(`/api/v1/tags/${id}`, { method: "DELETE" }),
    listTasks: (query) => request(`/api/v1/tasks${queryString(query)}`),
    getTask: (id) => request(`/api/v1/tasks/${id}`),
    createTask: (body, idempotencyKey) =>
      request("/api/v1/tasks", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Idempotency-Key": idempotencyKey },
      }),
    duplicateTask: (id) => request(`/api/v1/tasks/${id}/duplicate`, { method: "POST" }),
    postponeTask: (id) => request(`/api/v1/tasks/${id}/postpone`, { method: "POST" }),
    pinTask: (id, pinned) => request(`/api/v1/tasks/${id}/pin`, { method: "POST", body: JSON.stringify({ pinned }) }),
    assignTask: (id, userId) => request(`/api/v1/tasks/${id}/assign`, { method: "POST", body: JSON.stringify({ userId }) }),
    updateTask: (id, body) => request(`/api/v1/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    deleteTask: (id) => request(`/api/v1/tasks/${id}`, { method: "DELETE" }),
    restoreTask: (id) => request(`/api/v1/tasks/${id}/restore`, { method: "POST" }),
    restoreSelected: (ids) => request("/api/v1/tasks/restore", { method: "POST", body: JSON.stringify({ ids }) }),
    purgeTask: (id) => request(`/api/v1/tasks/${id}/purge`, { method: "POST" }),
    purgeSelected: (ids) => request("/api/v1/tasks/purge", { method: "POST", body: JSON.stringify({ ids }) }),
    restorePurged: (ids) => request("/api/v1/tasks/purge/restore", { method: "POST", body: JSON.stringify({ ids }) }),
    emptyTrash: () => request("/api/v1/tasks/empty-trash", { method: "POST" }),
    clearCompleted: () => request("/api/v1/tasks/clear-completed", { method: "POST" }),
    completeTask: (id) => request(`/api/v1/tasks/${id}/complete`, { method: "POST" }),
    finishSubtasks: (id) => request(`/api/v1/tasks/${id}/finish-subtasks`, { method: "POST" }),
    uncompleteTask: (id) => request(`/api/v1/tasks/${id}/uncomplete`, { method: "POST" }),
    skipTask: (id) => request(`/api/v1/tasks/${id}/skip`, { method: "POST" }),
    omitOccurrence: (id) => request(`/api/v1/tasks/${id}/omit`, { method: "POST" }),
    restoreOmittedOccurrence: (id) => request(`/api/v1/tasks/${id}/restore-omitted`, { method: "POST" }),
    archiveTask: (id) => request(`/api/v1/tasks/${id}/archive`, { method: "POST" }),
    unarchiveTask: (id) => request(`/api/v1/tasks/${id}/unarchive`, { method: "POST" }),
    reorderTasks: (ids) => request("/api/v1/tasks/reorder", { method: "POST", body: JSON.stringify({ ids }) }),
    sortTasks: (body) => request("/api/v1/tasks/sort", { method: "POST", body: JSON.stringify(body) }),
    batchTasks: (body) => request("/api/v1/tasks/batch", { method: "POST", body: JSON.stringify(body) }),
    devices: () => request("/api/v1/devices"),
    registerDevice: (body) => request("/api/v1/devices", { method: "POST", body: JSON.stringify(body) }),
    deleteDevice: (id) => request(`/api/v1/devices/${id}`, { method: "DELETE" }),
    billing: () => request("/api/v1/billing"),
    startCheckout: () => request("/api/v1/billing/checkout", { method: "POST" }),
    exportAccount: () => request("/api/v1/export"),
    importAccount: (body) => request("/api/v1/import", { method: "POST", body: JSON.stringify(body) }),
    revertImport: (body) => request("/api/v1/import/revert", { method: "POST", body: JSON.stringify(body) }),
    pendingReminders: () => request("/api/v1/reminders/pending"),
    ackReminder: (id) => request(`/api/v1/reminders/${id}/ack`, { method: "POST" }),
    unackReminder: (id) => request(`/api/v1/reminders/${id}/unack`, { method: "POST" }),
    snoozeReminder: (id, body) => request(`/api/v1/reminders/${id}/snooze`, { method: "POST", body: JSON.stringify(body) }),
  };
}
