"use client";

import { ApiError } from "@vela/api-client";
import { mergeTaskPatch, type TaskDto, type TaskMutation, type TaskSyncOp } from "@vela/shared";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { deleteMutation, readMutations, writeMutation } from "@/lib/sync-db";

export type SyncPhase = "synced" | "pending" | "retrying" | "attention";

export type SyncRetryResult = {
  remaining: number;
  attention: number;
};

interface SyncApi {
  phase: SyncPhase;
  mutations: TaskMutation[];
  retryNow: () => Promise<SyncRetryResult>;
  queueCreate: (body: Record<string, unknown>) => Promise<TaskDto | { id: string; queued: true }>;
  cancelQueuedCreate: (id: string) => Promise<void>;
  saveTask: (task: TaskDto, patch: Record<string, unknown>) => Promise<"saved" | "queued" | "attention">;
  completeTask: (task: TaskDto) => Promise<"saved" | "queued">;
  reopenTask: (task: TaskDto) => Promise<"saved" | "queued">;
  deleteTask: (task: TaskDto) => Promise<"saved" | "queued">;
  restoreTask: (task: TaskDto) => Promise<"saved" | "queued">;
  postponeTask: (task: TaskDto) => Promise<"saved" | "queued">;
  choose: (id: string, choice: "local" | "server") => Promise<void>;
}

const SyncContext = createContext<SyncApi | null>(null);

export function useSync(): SyncApi {
  const value = useContext(SyncContext);
  if (!value) throw new Error("Sync provider is missing.");
  return value;
}

function networkError(error: unknown): boolean {
  return !navigator.onLine || error instanceof TypeError;
}

function record(op: TaskSyncOp, entityId: string, payload: Record<string, unknown>, base: Record<string, unknown>, revision: number | null): TaskMutation {
  return {
    id: op === "create" ? entityId : crypto.randomUUID(),
    baseRevision: revision,
    entity: "task",
    entityId,
    op,
    payload,
    base,
    createdAt: new Date().toISOString(),
    attempt: 0,
    attention: null,
    serverRevision: null,
  };
}

export function SyncProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [mutations, setMutations] = useState<TaskMutation[]>([]);
  const [retrying, setRetrying] = useState(false);

  const refresh = useCallback(async () => {
    setMutations(await readMutations());
  }, []);

  const flush = useCallback(async (): Promise<SyncRetryResult> => {
    if (!navigator.onLine) {
      const queued = await readMutations();
      return {
        remaining: queued.length,
        attention: queued.filter((item) => item.attention?.length).length,
      };
    }
    setRetrying(true);
    try {
      const queued = (await readMutations()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const item of queued) {
        if (item.attention?.length) continue;
        try {
          await send(item);
          await deleteMutation(item.id);
        } catch (error) {
          if (networkError(error)) break;
          if (error instanceof ApiError && error.status === 409 && error.task && item.op === "update") {
            const { patch, conflicts } = mergeTaskPatch(item.base, item.payload, error.task as unknown as Record<string, unknown>);
            if (conflicts.length > 0) {
              await writeMutation({ ...item, attention: conflicts, serverRevision: error.task.revision, attempt: item.attempt + 1 });
              continue;
            }
            if (Object.keys(patch).length > 0) {
              await api.updateTask(item.entityId, { ...patch, revision: error.task.revision });
            }
            await deleteMutation(item.id);
            continue;
          }
          await writeMutation({ ...item, attempt: item.attempt + 1, attention: item.attempt >= 4 ? ["request"] : null });
        }
      }
    } finally {
      setRetrying(false);
      await refresh();
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
    }
    const after = await readMutations();
    return {
      remaining: after.length,
      attention: after.filter((item) => item.attention?.length).length,
    };
  }, [queryClient, refresh]);

  useEffect(() => {
    void refresh().then(() => flush());
    const onOnline = () => void flush();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [flush, refresh]);

  const queue = useCallback(
    async (item: TaskMutation) => {
      await writeMutation(item);
      await refresh();
      if (navigator.onLine) await flush();
    },
    [flush, refresh],
  );

  const apiValue = useMemo<SyncApi>(
    () => ({
      phase: retrying ? "retrying" : mutations.some((item) => item.attention?.length) ? "attention" : mutations.length > 0 ? "pending" : "synced",
      mutations,
      retryNow: flush,
      queueCreate: async (body) => {
        const id = crypto.randomUUID();
        if (navigator.onLine) {
          try {
            return await api.createTask(body, id);
          } catch (error) {
            if (!networkError(error)) throw error;
          }
        }
        await queue(record("create", id, body, {}, null));
        return { id, queued: true as const };
      },
      cancelQueuedCreate: async (id) => {
        const item = (await readMutations()).find((entry) => entry.op === "create" && entry.entityId === id);
        if (!item) return;
        await deleteMutation(item.id);
        await refresh();
      },
      saveTask: async (task, patch) => {
        const pending = mutations.find((item) => item.op === "create" && item.entityId === task.id);
        if (pending) {
          await queue({ ...pending, payload: { ...pending.payload, ...patch } });
          return "queued";
        }
        const base = snapshot(task);
        if (!navigator.onLine) {
          await queue(record("update", task.id, patch, base, task.revision));
          return "queued";
        }
        try {
          await api.updateTask(task.id, { ...patch, revision: task.revision });
          return "saved";
        } catch (error) {
          if (networkError(error)) {
            await queue(record("update", task.id, patch, base, task.revision));
            return "queued";
          }
          if (error instanceof ApiError && error.status === 409 && error.task) {
            const { patch: merged, conflicts } = mergeTaskPatch(base, patch, error.task as unknown as Record<string, unknown>);
            if (conflicts.length === 0) {
              if (Object.keys(merged).length > 0) await api.updateTask(task.id, { ...merged, revision: error.task.revision });
              return "saved";
            }
            await queue({
              ...record("update", task.id, patch, base, task.revision),
              attention: conflicts,
              serverRevision: error.task.revision,
            });
            return "attention";
          }
          throw error;
        }
      },
      completeTask: (task) => act("complete", task, () => api.completeTask(task.id)),
      reopenTask: (task) => act("reopen", task, () => api.uncompleteTask(task.id)),
      deleteTask: (task) => act("delete", task, () => api.deleteTask(task.id)),
      restoreTask: (task) => act("restore", task, () => api.restoreTask(task.id)),
      postponeTask: (task) => act("postpone", task, () => api.postponeTask(task.id)),
      choose: async (id, choice) => {
        const item = mutations.find((entry) => entry.id === id);
        if (!item) return;
        if (choice === "server") {
          await deleteMutation(id);
          await refresh();
          await queryClient.invalidateQueries({ queryKey: ["tasks"] });
          return;
        }
        if (!navigator.onLine) {
          throw new Error("You are offline. Reconnect to resolve that change.");
        }
        if (item.serverRevision !== null) {
          await api.updateTask(item.entityId, { ...item.payload, revision: item.serverRevision });
          await deleteMutation(id);
          await refresh();
          await queryClient.invalidateQueries({ queryKey: ["tasks"] });
          return;
        }
        try {
          await send({ ...item, attention: null });
          await deleteMutation(id);
        } catch (error) {
          if (error instanceof ApiError && error.status === 409 && error.task && item.op === "update") {
            const { patch, conflicts } = mergeTaskPatch(
              item.base,
              item.payload,
              error.task as unknown as Record<string, unknown>,
            );
            if (conflicts.length > 0) {
              await writeMutation({
                ...item,
                attention: conflicts,
                serverRevision: error.task.revision,
                attempt: item.attempt + 1,
              });
              await refresh();
              await queryClient.invalidateQueries({ queryKey: ["tasks"] });
              throw new Error("A newer edit is on the server. Choose again.");
            }
            if (Object.keys(patch).length > 0) {
              await api.updateTask(item.entityId, { ...patch, revision: error.task.revision });
            }
            await deleteMutation(id);
          } else if (networkError(error)) {
            throw new Error("You are offline. Reconnect to resolve that change.");
          } else {
            await writeMutation({
              ...item,
              attempt: item.attempt + 1,
              attention: item.attempt >= 4 ? ["request"] : null,
            });
            await refresh();
            throw error instanceof ApiError ? error : new Error("Could not keep your copy.");
          }
        }
        await refresh();
        await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      },
    }),
    [flush, mutations, queryClient, queue, refresh],
  );

  async function act(op: TaskSyncOp, task: TaskDto, sendNow: () => Promise<unknown>): Promise<"saved" | "queued"> {
    if (!navigator.onLine) {
      await queue(record(op, task.id, {}, snapshot(task), task.revision));
      return "queued";
    }
    try {
      await sendNow();
      return "saved";
    } catch (error) {
      if (!networkError(error)) throw error;
      await queue(record(op, task.id, {}, snapshot(task), task.revision));
      return "queued";
    }
  }

  return <SyncContext.Provider value={apiValue}>{children}</SyncContext.Provider>;
}

async function send(item: TaskMutation): Promise<void> {
  if (item.op === "create") {
    await api.createTask(item.payload, item.id);
    return;
  }
  if (item.op === "update") {
    await api.updateTask(item.entityId, { ...item.payload, revision: item.baseRevision });
    return;
  }
  if (item.op === "complete") {
    await api.completeTask(item.entityId);
    return;
  }
  if (item.op === "reopen") {
    await api.uncompleteTask(item.entityId);
    return;
  }
  if (item.op === "delete") {
    await api.deleteTask(item.entityId);
    return;
  }
  if (item.op === "postpone") {
    await api.postponeTask(item.entityId);
    return;
  }
  await api.restoreTask(item.entityId);
}

function snapshot(task: TaskDto): Record<string, unknown> {
  return {
    title: task.title,
    description: task.description,
    priority: task.priority,
    listId: task.listId,
    dueAt: task.dueAt,
    dueHasTime: task.dueHasTime,
    startAt: task.startAt,
    tagIds: task.tagIds,
  };
}
