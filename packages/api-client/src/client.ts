import type {
  ErrorBody,
  ListDto,
  MetaDto,
  ReminderDto,
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
  updateProfile: (body: { name?: string; timeZone?: string }) => Promise<UserDto>;
  changePassword: (body: { currentPassword: string; newPassword: string }) => Promise<void>;
  requestRecovery: (body: { email: string }) => Promise<void>;
  lists: () => Promise<ListDto[]>;
  createList: (body: { name: string; color?: string; icon?: string }) => Promise<ListDto>;
  updateList: (id: string, body: { name?: string; color?: string; icon?: string; archived?: boolean }) => Promise<ListDto>;
  deleteList: (id: string) => Promise<void>;
  tags: () => Promise<TagDto[]>;
  createTag: (body: { name: string; color?: string }) => Promise<TagDto>;
  updateTag: (id: string, body: { name?: string; color?: string }) => Promise<TagDto>;
  deleteTag: (id: string) => Promise<void>;
  listTasks: (query: Record<string, string | undefined>) => Promise<TaskListResponse>;
  getTask: (id: string) => Promise<{ task: TaskDto; subtasks: TaskDto[] }>;
  createTask: (body: Record<string, unknown>, idempotencyKey: string) => Promise<TaskDto>;
  updateTask: (id: string, body: Record<string, unknown>) => Promise<TaskDto>;
  deleteTask: (id: string) => Promise<void>;
  restoreTask: (id: string) => Promise<TaskDto>;
  completeTask: (id: string) => Promise<TaskDto>;
  uncompleteTask: (id: string) => Promise<TaskDto>;
  skipTask: (id: string) => Promise<TaskDto>;
  archiveTask: (id: string) => Promise<TaskDto>;
  unarchiveTask: (id: string) => Promise<TaskDto>;
  reorderTasks: (ids: string[]) => Promise<void>;
  batchTasks: (body: { ids: string[]; action: "complete" | "delete" }) => Promise<{ tasks: TaskDto[] }>;
  pendingReminders: () => Promise<ReminderDto[]>;
  ackReminder: (id: string) => Promise<void>;
}

export function createApiClient(baseUrl = ""): ApiClient {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
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
    requestRecovery: (body) =>
      request("/api/v1/auth/recovery", { method: "POST", body: JSON.stringify(body) }),
    lists: () => request("/api/v1/lists"),
    createList: (body) => request("/api/v1/lists", { method: "POST", body: JSON.stringify(body) }),
    updateList: (id, body) => request(`/api/v1/lists/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    deleteList: (id) => request(`/api/v1/lists/${id}`, { method: "DELETE" }),
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
    updateTask: (id, body) => request(`/api/v1/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    deleteTask: (id) => request(`/api/v1/tasks/${id}`, { method: "DELETE" }),
    restoreTask: (id) => request(`/api/v1/tasks/${id}/restore`, { method: "POST" }),
    completeTask: (id) => request(`/api/v1/tasks/${id}/complete`, { method: "POST" }),
    uncompleteTask: (id) => request(`/api/v1/tasks/${id}/uncomplete`, { method: "POST" }),
    skipTask: (id) => request(`/api/v1/tasks/${id}/skip`, { method: "POST" }),
    archiveTask: (id) => request(`/api/v1/tasks/${id}/archive`, { method: "POST" }),
    unarchiveTask: (id) => request(`/api/v1/tasks/${id}/unarchive`, { method: "POST" }),
    reorderTasks: (ids) => request("/api/v1/tasks/reorder", { method: "POST", body: JSON.stringify({ ids }) }),
    batchTasks: (body) => request("/api/v1/tasks/batch", { method: "POST", body: JSON.stringify(body) }),
    pendingReminders: () => request("/api/v1/reminders/pending"),
    ackReminder: (id) => request(`/api/v1/reminders/${id}/ack`, { method: "POST" }),
  };
}
