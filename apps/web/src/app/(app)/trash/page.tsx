"use client";

import { ApiError } from "@vela/api-client";
import { Button } from "@vela/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useOnline, useToast } from "@/components/providers";
import { api } from "@/lib/api";

export default function TrashPage() {
  const [undated, setUndated] = useState(false);
  const tasks = useQuery({
    queryKey: ["tasks", { view: "trash", due: undated ? "none" : undefined }],
    queryFn: () => api.listTasks({ view: "trash", due: undated ? "none" : undefined }),
  });
  const queryClient = useQueryClient();
  const toast = useToast();
  const online = useOnline();
  const busy = useRef(false);
  const selectAllRef = useRef<HTMLButtonElement | null>(null);
  const filterAnchorRef = useRef<HTMLButtonElement | null>(null);
  const [hidden, setHidden] = useState<string[]>([]);
  const [checked, setChecked] = useState<string[]>([]);

  const visible = (tasks.data?.tasks ?? []).filter((task) => !hidden.includes(task.id));
  const chosen = checked.filter((id) => visible.some((task) => task.id === id));
  const filtered = undated;

  function canFocusTrash(element: HTMLElement | null): element is HTMLElement {
    if (!element || !document.contains(element)) return false;
    if (
      (element instanceof HTMLButtonElement ||
        element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement) &&
      element.disabled
    ) {
      return false;
    }
    return true;
  }

  function focusTrashTargets(...ids: string[]) {
    queueMicrotask(() => {
      for (const id of ids) {
        const target = document.getElementById(id);
        if (!canFocusTrash(target)) continue;
        target.focus();
        return;
      }
      document.getElementById("trash-heading")?.focus();
    });
  }

  function clearTrashSelection() {
    setChecked([]);
    queueMicrotask(() => (selectAllRef.current ?? document.getElementById("trash-heading"))?.focus());
  }

  function clearTrashFilters() {
    setUndated(false);
    queueMicrotask(() => (filterAnchorRef.current ?? document.getElementById("trash-heading"))?.focus());
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (isTextEntry(target)) {
        target.blur();
        event.preventDefault();
        return;
      }
      if (document.querySelector('[role="dialog"]')) return;
      if (checked.length > 0) {
        event.preventDefault();
        clearTrashSelection();
        return;
      }
      if (undated) {
        event.preventDefault();
        clearTrashFilters();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [checked.length, undated]);

  function toggle(id: string) {
    setChecked((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  async function restore(id: string) {
    const focusRestore = () => focusTrashTargets(`trash-restore-${id}`, "restore-selected");
    if (!online) {
      toast.push("You are offline. Reconnect to restore that task.");
      focusRestore();
      return;
    }
    if (busy.current || hidden.includes(id)) return;
    busy.current = true;
    const rows = tasks.data?.tasks ?? [];
    const task = rows.find((item) => item.id === id);
    const children = rows.filter((item) => item.parentId === id).map((item) => item.id);
    const parentStillDeleted = Boolean(task?.parentId && rows.some((item) => item.id === task.parentId));
    const removed = [id, ...children];
    setHidden((current) => [...current, ...removed]);
    setChecked((current) => current.filter((item) => !removed.includes(item)));
    try {
      await api.restoreTask(id);
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      const withChildren = children.length === 1 ? " Its subtask was restored too." : children.length > 1 ? " Its subtasks were restored too." : "";
      const onItsOwn = parentStillDeleted ? " It is on its own because its task is still in Trash." : "";
      toast.push(`Task restored.${withChildren}${onItsOwn}`, {
        label: "Undo",
        run: () => {
          const focusAfter = () => focusRestore();
          if (!navigator.onLine) {
            toast.push("You are offline. Reconnect to move that task back to Trash.");
            focusAfter();
            return;
          }
          void api
            .deleteTask(id)
            .then(async () => {
              setHidden((current) => current.filter((item) => !removed.includes(item)));
              await queryClient.invalidateQueries({ queryKey: ["tasks"] });
              toast.push("Moved back to Trash.");
              focusAfter();
            })
            .catch((error: unknown) => {
              void queryClient.invalidateQueries({ queryKey: ["tasks"] });
              toast.push(error instanceof ApiError ? error.message : "Could not move that task to Trash.");
              focusAfter();
            });
        },
      });
      focusRestore();
    } catch (error) {
      setHidden((current) => current.filter((item) => !removed.includes(item)));
      toast.push(error instanceof ApiError ? error.message : "Could not restore that task.");
      focusRestore();
    } finally {
      busy.current = false;
    }
  }

  async function restoreSelected() {
    const focusRestore = () => focusTrashTargets("restore-selected");
    if (!online) {
      toast.push("You are offline. Reconnect to restore the selection.");
      focusRestore();
      return;
    }
    if (busy.current || chosen.length === 0) return;
    busy.current = true;
    const ids = [...chosen];
    const rows = visible;
    try {
      const result = await api.restoreSelected(ids);
      clearTrashSelection();
      const restoredIds = new Set(result.tasks.map((task) => task.id));
      const removed = rows
        .filter((task) => restoredIds.has(task.id) || (task.parentId !== null && restoredIds.has(task.parentId)))
        .map((task) => task.id);
      setHidden((current) => [...current, ...removed]);
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      if (result.restored === 0 && result.skipped > 0) {
        toast.push(result.skipped === 1 ? "That task is already open." : "Those tasks are already open.");
        focusRestore();
        return;
      }
      if (result.restored === 0) {
        toast.push("No tasks to restore.");
        focusRestore();
        return;
      }
      const selectedSubtasks = ids.some((id) => {
        const row = rows.find((task) => task.id === id);
        return Boolean(row?.parentId && restoredIds.has(row.parentId));
      });
      const main = result.restored === 1 ? "Restored 1 task." : `Restored ${result.restored} tasks.`;
      const extra = selectedSubtasks
        ? result.restored === 1
          ? " Its selected subtasks went with it."
          : " Selected subtasks went with them."
        : "";
      const stayed =
        result.skipped === 1
          ? " 1 was already open."
          : result.skipped > 1
            ? ` ${result.skipped} were already open.`
            : "";
      const roots = result.tasks.map((task) => task.id);
      toast.push(`${main}${extra}${stayed}`, {
        label: "Undo",
        run: () => {
          const focusAfter = () => focusRestore();
          if (!navigator.onLine) {
            toast.push("You are offline. Reconnect to move the selection back to Trash.");
            focusAfter();
            return;
          }
          void api
            .batchTasks({ ids: roots, action: "delete" })
            .then(async (deleted) => {
              setHidden((current) => current.filter((item) => !removed.includes(item)));
              const count = deleted.tasks.length;
              await queryClient.invalidateQueries({ queryKey: ["tasks"] });
              toast.push(count === 1 ? "Moved 1 task back to Trash." : `Moved ${count} tasks back to Trash.`);
              focusAfter();
            })
            .catch((error: unknown) => {
              void queryClient.invalidateQueries({ queryKey: ["tasks"] });
              toast.push(error instanceof ApiError ? error.message : "Could not move the selection to Trash.");
              focusAfter();
            });
        },
      });
      focusRestore();
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not restore the selection.");
      focusRestore();
    } finally {
      busy.current = false;
    }
  }

  async function purge(id: string) {
    const focusPurge = () => focusTrashTargets(`trash-delete-forever-${id}`, "delete-forever-selected");
    if (!online) {
      toast.push("You are offline. Reconnect to delete forever.");
      focusPurge();
      return;
    }
    if (busy.current || hidden.includes(id)) return;
    busy.current = true;
    const children = (tasks.data?.tasks ?? []).filter((task) => task.parentId === id).map((task) => task.id);
    const removed = [id, ...children];
    setHidden((current) => [...current, ...removed]);
    setChecked((current) => current.filter((item) => !removed.includes(item)));
    try {
      const result = await api.purgeTask(id);
      setHidden((current) => current.filter((item) => !result.detachedIds.includes(item)));
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      const deletedChildren = result.deletedIds.filter((item) => item !== id).length;
      const extra = deletedChildren === 1 ? " Its subtask was deleted too." : deletedChildren > 1 ? " Its subtasks were deleted too." : "";
      const stayed =
        result.detachedIds.length === 1
          ? " 1 stays on its own because someone else added it."
          : result.detachedIds.length > 1
            ? ` ${result.detachedIds.length} stay on their own because someone else added them.`
            : "";
      const purgedIds = result.deletedIds;
      toast.push(`Task deleted forever.${extra}${stayed}`, {
        label: "Undo",
        run: () => {
          const focusAfter = () => focusPurge();
          if (!navigator.onLine) {
            toast.push("You are offline. Reconnect to move those tasks back to Trash.");
            focusAfter();
            return;
          }
          void api
            .restorePurged(purgedIds)
            .then(async () => {
              setHidden((current) => current.filter((item) => !purgedIds.includes(item)));
              await queryClient.invalidateQueries({ queryKey: ["tasks"] });
              toast.push(purgedIds.length === 1 ? "Moved 1 task back to Trash." : `Moved ${purgedIds.length} tasks back to Trash.`);
              focusAfter();
            })
            .catch((error: unknown) => {
              toast.push(error instanceof ApiError ? error.message : "Could not restore those tasks.");
              focusAfter();
            });
        },
      });
      focusPurge();
    } catch (error) {
      setHidden((current) => current.filter((item) => !removed.includes(item)));
      toast.push(error instanceof ApiError ? error.message : "Could not delete that task.");
      focusPurge();
    } finally {
      busy.current = false;
    }
  }

  async function purgeSelected() {
    const focusPurge = () => focusTrashTargets("delete-forever-selected");
    if (!online) {
      toast.push("You are offline. Reconnect to delete forever.");
      focusPurge();
      return;
    }
    if (busy.current || chosen.length === 0) return;
    busy.current = true;
    const ids = [...chosen];
    try {
      const result = await api.purgeSelected(ids);
      clearTrashSelection();
      setHidden((current) => [...current, ...result.deletedIds]);
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      if (result.purged === 0 && result.kept > 0) {
        toast.push(
          result.kept === 1
            ? "That task was added by someone else."
            : "Those tasks were added by someone else.",
        );
        focusPurge();
        return;
      }
      if (result.purged === 0) {
        toast.push("No tasks to delete forever.");
        focusPurge();
        return;
      }
      const removed = result.purged === 1 ? "Deleted 1 task forever." : `Deleted ${result.purged} tasks forever.`;
      const stayed =
        result.kept === 1
          ? " 1 stays because someone else added it."
          : result.kept > 1
            ? ` ${result.kept} stay because someone else added them.`
            : "";
      const detached =
        result.detachedIds.length === 1
          ? " 1 stays on its own because someone else added it."
          : result.detachedIds.length > 1
            ? ` ${result.detachedIds.length} stay on their own because someone else added them.`
            : "";
      const purgedIds = result.deletedIds;
      toast.push(`${removed}${stayed}${detached}`, {
        label: "Undo",
        run: () => {
          const focusAfter = () => focusPurge();
          if (!navigator.onLine) {
            toast.push("You are offline. Reconnect to move those tasks back to Trash.");
            focusAfter();
            return;
          }
          void api
            .restorePurged(purgedIds)
            .then(async () => {
              setHidden((current) => current.filter((item) => !purgedIds.includes(item)));
              await queryClient.invalidateQueries({ queryKey: ["tasks"] });
              toast.push(purgedIds.length === 1 ? "Moved 1 task back to Trash." : `Moved ${purgedIds.length} tasks back to Trash.`);
              focusAfter();
            })
            .catch((error: unknown) => {
              toast.push(error instanceof ApiError ? error.message : "Could not restore those tasks.");
              focusAfter();
            });
        },
      });
      focusPurge();
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not delete the selection.");
      focusPurge();
    } finally {
      busy.current = false;
    }
  }

  async function empty() {
    const focusEmpty = () => focusTrashTargets("empty-trash");
    if (!online) {
      toast.push("You are offline. Reconnect to empty Trash.");
      focusEmpty();
      return;
    }
    if (busy.current) return;
    busy.current = true;
    try {
      const result = await api.emptyTrash();
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      setChecked([]);
      focusEmpty();
      if (result.purged === 0 && result.kept > 0) {
        toast.push("The remaining tasks were added by someone else.");
        return;
      }
      if (result.purged === 0) {
        toast.push("Trash is already empty.");
        return;
      }
      const removed = result.purged === 1 ? "Deleted 1 task forever." : `Deleted ${result.purged} tasks forever.`;
      const stayed = result.kept === 1 ? " 1 stays because someone else added it." : result.kept > 1 ? ` ${result.kept} stay because someone else added them.` : "";
      const purgedIds = result.deletedIds;
      toast.push(`${removed}${stayed}`, {
        label: "Undo",
        run: () => {
          const focusAfter = () => focusEmpty();
          if (!navigator.onLine) {
            toast.push("You are offline. Reconnect to move those tasks back to Trash.");
            focusAfter();
            return;
          }
          void api
            .restorePurged(purgedIds)
            .then(async () => {
              await queryClient.invalidateQueries({ queryKey: ["tasks"] });
              toast.push(purgedIds.length === 1 ? "Moved 1 task back to Trash." : `Moved ${purgedIds.length} tasks back to Trash.`);
              focusAfter();
            })
            .catch((error: unknown) => {
              toast.push(error instanceof ApiError ? error.message : "Could not restore those tasks.");
              focusAfter();
            });
        },
      });
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not empty Trash.");
      focusEmpty();
    } finally {
      busy.current = false;
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 id="trash-heading" className="font-serif text-4xl" tabIndex={-1}>
            Trash
          </h1>
          <p className="mt-2 max-w-xl text-sm text-muted">
            Deleted tasks stay here. A subtask says which task it belongs to. Restore puts one task back, and its subtasks come back with it. Undo moves it back to Trash. A subtask whose task is still in Trash comes back on its own. Select tasks to restore them, or to delete them forever. Undo moves a restored selection back to Trash. A task that is already open stays when you restore the selection. Delete forever removes it and the subtasks you added. Undo puts them back in Trash for five minutes. A task someone else added stays when you delete the selection forever. A subtask someone else added stays in Trash on its own. Only the person who added a task can do that. Empty Trash does the same for every deleted task you added, and says when someone else&apos;s deleted tasks stay.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          {visible.length > 0 ? (
            <button
              ref={selectAllRef}
              className="text-sm text-accent"
              type="button"
              aria-label="Select all in Trash"
              onClick={() => setChecked(visible.map((task) => task.id))}
            >
              Select all
            </button>
          ) : null}
          {chosen.length > 0 ? (
            <button className="text-sm text-accent" type="button" aria-label="Clear Trash selection" onClick={clearTrashSelection}>
              Clear selection
            </button>
          ) : null}
          {visible.length > 0 ? (
            <Button
              id="empty-trash"
              type="button"
              variant="danger"
              disabled={!online}
              aria-label="Empty Trash forever"
              onClick={() => void empty()}
            >
              Empty Trash
            </Button>
          ) : null}
        </div>
      </div>
      {!online ? <p className="mt-3 text-sm text-muted">You are offline. Reconnect to restore or delete forever.</p> : null}
      {chosen.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            id="restore-selected"
            type="button"
            size="sm"
            variant="secondary"
            disabled={!online}
            aria-label="Restore selected"
            onClick={() => void restoreSelected()}
          >
            Restore selected
          </Button>
          <Button
            id="delete-forever-selected"
            type="button"
            size="sm"
            variant="danger"
            disabled={!online}
            aria-label="Delete selected forever"
            onClick={() => void purgeSelected()}
          >
            Delete forever
          </Button>
        </div>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2 text-sm">
        <button
          ref={filterAnchorRef}
          type="button"
          aria-pressed={undated}
          aria-label="No date in Trash"
          className={`rounded-full px-3 py-1 ${undated ? "bg-accent text-accent-ink" : "bg-sidebar"}`}
          onClick={() => setUndated((value) => !value)}
        >
          No date
        </button>
        {filtered ? (
          <button type="button" className="rounded-full px-3 py-1 text-accent" aria-label="Clear Trash filters" onClick={clearTrashFilters}>
            Clear filters
          </button>
        ) : null}
      </div>
      {tasks.isLoading ? (
        <p className="mt-6 text-sm text-muted" role="status">
          Loading Trash…
        </p>
      ) : null}
      {tasks.isError ? (
        <div className="mt-6 text-sm">
          <p>Trash could not be loaded.</p>
          <button className="mt-2 text-accent" type="button" aria-label="Trash could not be loaded. Try again" onClick={() => void tasks.refetch()}>
            Try again
          </button>
        </div>
      ) : null}
      {tasks.data ? (
        <ul className="mt-6 divide-y divide-line rounded-xl border border-line bg-surface">
          {visible.map((task) => (
            <li key={task.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-3 text-sm">
              <label className="flex min-w-0 items-center gap-2">
                <input
                  type="checkbox"
                  aria-label={`Select ${task.title}`}
                  checked={checked.includes(task.id)}
                  onChange={() => toggle(task.id)}
                />
                <span className="min-w-0">
                  <span className="block font-medium">{task.title}</span>
                  {task.parentTitle ? <span className="mt-1 block text-xs text-muted">Subtask of {task.parentTitle}</span> : null}
                  {task.deletedAt ? <span className="mt-1 block text-xs text-muted">Deleted {new Date(task.deletedAt).toLocaleString()}</span> : null}
                </span>
              </label>
              <span className="flex gap-2">
                <Button
                  id={`trash-restore-${task.id}`}
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={!online}
                  aria-label={`Restore ${task.title}`}
                  onClick={() => void restore(task.id)}
                >
                  Restore
                </Button>
                <Button
                  id={`trash-delete-forever-${task.id}`}
                  type="button"
                  size="sm"
                  variant="danger"
                  disabled={!online}
                  aria-label={`Delete forever ${task.title}`}
                  onClick={() => void purge(task.id)}
                >
                  Delete forever
                </Button>
              </span>
            </li>
          ))}
          {visible.length === 0 ? (
            <li className="px-3 py-8 text-center text-sm text-muted" role="status">
              {filtered ? (
                <>
                  <p className="font-medium">No tasks match these filters</p>
                  <p className="mt-1">Clear filters to see the full Trash again.</p>
                  <button className="mt-3 text-accent" type="button" aria-label="Clear Trash filters" onClick={clearTrashFilters}>
                    Clear filters
                  </button>
                </>
              ) : (
                "Trash is empty."
              )}
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

function isTextEntry(target: HTMLElement | null): target is HTMLElement {
  if (!target) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === "TEXTAREA") return true;
  if (target.tagName !== "INPUT") return false;
  const type = (target as HTMLInputElement).type;
  return type !== "checkbox" && type !== "radio" && type !== "button" && type !== "submit" && type !== "reset";
}
