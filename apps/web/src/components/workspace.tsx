"use client";

import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { ApiError } from "@vela/api-client";
import { overlayTasks, type Priority, isOverdue } from "@vela/shared";
import { combineDateAndTime } from "@vela/shared";
import { Button, Input } from "@vela/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarBoard } from "@/components/calendar-board";
import { useOnline, useToast } from "@/components/providers";
import { useSync } from "@/components/sync-provider";
import { TaskDetail } from "@/components/task-detail";
import { TaskRow } from "@/components/task-row";
import { api } from "@/lib/api";

type RepeatRule = {
  frequency: string;
  interval: number;
  byWeekday?: number[];
  count?: number;
  until?: string;
} | null;

function sameRepeat(current: RepeatRule, next: RepeatRule) {
  if (!next && !current) return true;
  if (!next || !current) return false;
  const currentDays = [...(current.byWeekday ?? [])].sort((left, right) => left - right).join(",");
  const nextDays = [...(next.byWeekday ?? [])].sort((left, right) => left - right).join(",");
  return (
    current.frequency === next.frequency &&
    current.interval === next.interval &&
    currentDays === nextDays &&
    (current.count ?? null) === (next.count ?? null) &&
    (current.until ?? null) === (next.until ?? null)
  );
}

function encodeRepeat(rule: RepeatRule) {
  if (!rule) return "";
  return JSON.stringify({
    frequency: rule.frequency,
    interval: rule.interval,
    byWeekday: [...(rule.byWeekday ?? [])].sort((left, right) => left - right),
    count: rule.count ?? null,
    until: rule.until ?? null,
  });
}

function decodeRepeat(key: string): RepeatRule {
  if (!key) return null;
  const parsed = JSON.parse(key) as {
    frequency: "daily" | "weekly" | "monthly" | "yearly";
    interval: number;
    byWeekday: number[];
    count: number | null;
    until: string | null;
  };
  return {
    frequency: parsed.frequency,
    interval: parsed.interval,
    ...(parsed.byWeekday.length > 0 ? { byWeekday: parsed.byWeekday } : {}),
    ...(parsed.count !== null ? { count: parsed.count } : {}),
    ...(parsed.until ? { until: parsed.until } : {}),
  };
}

function sortRank(
  tasks: { id: string; title: string; dueAt: string | null; priority: Priority }[],
  by: "due" | "priority" | "title",
) {
  const priorityRank: Record<Priority, number> = { high: 0, medium: 1, low: 2, none: 3 };
  return [...tasks].sort((left, right) => {
    const title = left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
    if (by === "title") return title;
    if (by === "priority") return priorityRank[left.priority] - priorityRank[right.priority] || title;
    if (!left.dueAt && !right.dueAt) return title;
    if (!left.dueAt) return 1;
    if (!right.dueAt) return -1;
    return new Date(left.dueAt).getTime() - new Date(right.dueAt).getTime() || title;
  });
}

export type WorkspaceView =
  | { kind: "inbox" | "today" | "upcoming" | "all" | "completed" | "calendar" }
  | { kind: "list"; listId: string }
  | { kind: "tag"; tagId: string }
  | { kind: "search"; query: string };

const titles: Record<string, string> = {
  inbox: "Inbox",
  today: "Today",
  upcoming: "Upcoming",
  all: "All tasks",
  completed: "Completed",
  calendar: "Calendar",
};

function canFocusWorkspaceControl(element: HTMLElement | null): element is HTMLElement {
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
  return element.getAttribute("aria-disabled") !== "true";
}

export function Workspace({ view }: { view: WorkspaceView }) {
  const online = useOnline();
  const toast = useToast();
  const sync = useSync();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.me(), retry: false });
  const lists = useQuery({ queryKey: ["lists"], queryFn: () => api.lists(), enabled: Boolean(me.data) });
  const tags = useQuery({ queryKey: ["tags"], queryFn: () => api.tags(), enabled: Boolean(me.data) });
  const [priority, setPriority] = useState<Priority | "">("");
  const [undated, setUndated] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detailOpenerRef = useRef<HTMLElement | null>(null);
  const selectToggleRef = useRef<HTMLButtonElement | null>(null);
  const filterAnchorRef = useRef<HTMLButtonElement | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [checked, setChecked] = useState<string[]>([]);
  const [moveTo, setMoveTo] = useState("");
  const [priorityTo, setPriorityTo] = useState<Priority | "">("");
  const [dueOn, setDueOn] = useState("");
  const [dueAtTime, setDueAtTime] = useState("");
  const [startOn, setStartOn] = useState("");
  const [estimateTo, setEstimateTo] = useState("");
  const [tagTo, setTagTo] = useState("");
  const [reminderTo, setReminderTo] = useState("");
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [mine, setMine] = useState(false);
  const [assignTo, setAssignTo] = useState("");
  const [repeatTo, setRepeatTo] = useState("");
  const [repeatEvery, setRepeatEvery] = useState("1");
  const [repeatCount, setRepeatCount] = useState("");
  const [repeatUntil, setRepeatUntil] = useState("");
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [draftTitle, setDraftTitle] = useState("");
  const [parentTo, setParentTo] = useState("");
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const params = useMemo(() => {
    const base: Record<string, string | undefined> = {};
    if (priority) base.priority = priority;
    const dated = view.kind === "today" || view.kind === "upcoming" || view.kind === "calendar";
    const canOverdue = view.kind !== "upcoming" && view.kind !== "completed" && view.kind !== "calendar";
    if (overdueOnly && canOverdue) base.due = "overdue";
    else if (undated && !dated) base.due = "none";
    if (waiting && (view.kind === "today" || view.kind === "upcoming")) base.started = "waiting";
    if (pinnedOnly && view.kind !== "calendar") base.pinned = "true";
    if (mine && view.kind !== "calendar") base.assignee = "me";
    if (view.kind === "list") return { ...base, view: "list", listId: view.listId };
    if (view.kind === "tag") return { ...base, view: "tag", tagId: view.tagId };
    if (view.kind === "search") return { ...base, view: "search", q: view.query || undefined };
    if (view.kind === "calendar") return base;
    return { ...base, view: view.kind };
  }, [priority, undated, waiting, pinnedOnly, overdueOnly, mine, view]);

  const tasks = useQuery({
    queryKey: ["tasks", params],
    queryFn: () => api.listTasks(params),
    enabled: Boolean(me.data) && view.kind !== "calendar",
  });

  function openTask(id: string) {
    if (!selectedId) {
      const active = document.activeElement;
      if (active instanceof HTMLElement) detailOpenerRef.current = active;
    }
    setSelectedId(id);
  }

  function closeTask() {
    setSelectedId(null);
    const opener = detailOpenerRef.current;
    detailOpenerRef.current = null;
    queueMicrotask(() => {
      if (canFocusWorkspaceControl(opener)) opener.focus();
      else document.getElementById("workspace-heading")?.focus();
    });
  }

  function clearListSelection() {
    setChecked([]);
    queueMicrotask(() => (selectToggleRef.current ?? document.getElementById("workspace-heading"))?.focus());
  }

  function focusSelectionControl(id: string) {
    queueMicrotask(() => {
      const control = document.getElementById(id);
      const focusable =
        control &&
        !(
          (control instanceof HTMLButtonElement ||
            control instanceof HTMLInputElement ||
            control instanceof HTMLSelectElement ||
            control instanceof HTMLTextAreaElement) &&
          control.disabled
        ) &&
        control.getAttribute("aria-disabled") !== "true";
      if (focusable) control.focus();
      else (selectToggleRef.current ?? document.getElementById("workspace-heading"))?.focus();
    });
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = isTextEntry(target);
      const otherDialog = [...document.querySelectorAll('[role="dialog"]')].some(
        (el) => el.getAttribute("aria-labelledby") !== "task-detail-title",
      );
      if (event.key.toLowerCase() === "c" && !typing) {
        if (event.defaultPrevented) return;
        if (otherDialog) return;
        const field = document.getElementById("quick-add");
        if (!field) return;
        event.preventDefault();
        field.focus();
      }
      if (event.key === "Escape") {
        if (event.defaultPrevented) return;
        if (typing && target) {
          if (otherDialog) return;
          target.blur();
          event.preventDefault();
          return;
        }
        if (otherDialog) return;
        if (selectedId) {
          event.preventDefault();
          closeTask();
          return;
        }
        if (selecting) {
          event.preventDefault();
          setSelecting(false);
          setChecked([]);
          queueMicrotask(() => (selectToggleRef.current ?? document.getElementById("workspace-heading"))?.focus());
          return;
        }
        if (priority || undated || waiting || pinnedOnly || overdueOnly || mine) {
          event.preventDefault();
          clearFilters();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, selecting, priority, undated, waiting, pinnedOnly, overdueOnly, mine]);

  const heading = headingFor(view, lists.data ?? [], tags.data ?? [], lists.isError, tags.isError);
  const inboxId = (lists.data ?? []).find((list) => list.isInbox)?.id;
  const rows = overlayTasks(tasks.data?.tasks ?? [], sync.mutations).filter((task) => {
    if (task.deletedAt) return false;
    if (view.kind === "completed") return task.status === "completed";
    if (view.kind === "search") return task.status === "open" || task.status === "completed";
    if (view.kind === "calendar" || view.kind === "tag") return task.status === "open";
    if (task.status !== "open") return false;
    if (view.kind === "inbox" && inboxId) return task.listId === inboxId && !task.parentId;
    if (view.kind === "list") return task.listId === view.listId && !task.parentId;
    return true;
  });
  const selectedListIds = [...new Set(rows.filter((task) => checked.includes(task.id)).map((task) => task.listId))];
  const assignListId = selectedListIds.length === 1 ? (selectedListIds[0] ?? "") : "";
  const members = useQuery({
    queryKey: ["members", assignListId],
    queryFn: () => api.listMembers(assignListId),
    enabled: Boolean(me.data) && Boolean(assignListId) && selecting && view.kind !== "completed",
  });
  const filtered = Boolean(priority || undated || waiting || pinnedOnly || overdueOnly || mine);

  function clearFilters() {
    setPriority("");
    setUndated(false);
    setWaiting(false);
    setPinnedOnly(false);
    setOverdueOnly(false);
    setMine(false);
    queueMicrotask(() => (filterAnchorRef.current ?? document.getElementById("workspace-heading"))?.focus());
  }
  const sortable = online && (view.kind === "inbox" || view.kind === "list" || view.kind === "all") && !filtered;
  const rowKey = rows.map((task) => task.id).join("\n");
  useEffect(() => {
    const allowed = new Set(rowKey ? rowKey.split("\n") : []);
    setChecked((current) => {
      const next = current.filter((id) => allowed.has(id));
      return next.length === current.length ? current : next;
    });
  }, [rowKey]);
  function chosenIds() {
    const allowed = new Set(rowKey ? rowKey.split("\n") : []);
    return checked.filter((id) => allowed.has(id));
  }
  const sortListId = view.kind === "list" ? view.listId : view.kind === "inbox" ? inboxId : undefined;
  const canSort = Boolean(sortListId) && !priority && !undated && !pinnedOnly && !overdueOnly && !mine && (lists.data ?? []).some((list) => list.id === sortListId && list.role === "owner");
  const overdueCount =
    view.kind === "today"
      ? rows.filter((task) => task.dueAt && isOverdue(task.dueAt, me.data?.timeZone ?? "UTC", new Date().toISOString())).length
      : 0;

  function focusSortControl(by: "due" | "priority" | "title") {
    queueMicrotask(() => {
      const control = document.getElementById(`sort-by-${by}`);
      const focusable =
        control &&
        !(
          (control instanceof HTMLButtonElement ||
            control instanceof HTMLInputElement ||
            control instanceof HTMLSelectElement ||
            control instanceof HTMLTextAreaElement) &&
          control.disabled
        ) &&
        control.getAttribute("aria-disabled") !== "true";
      if (focusable) control.focus();
      else document.getElementById("workspace-heading")?.focus();
    });
  }

  async function sortTasks(by: "due" | "priority" | "title") {
    if (!sortListId) return;
    if (!online) {
      toast.push("You are offline. Reconnect to sort those tasks.");
      focusSortControl(by);
      return;
    }
    const label = by === "due" ? "due date" : by;
    const sortableRows = rows.filter((task) => !task.parentId && task.status === "open");
    if (sortableRows.length === 0) {
      toast.push("This list has no tasks to sort.");
      focusSortControl(by);
      return;
    }
    const previousIds = sortableRows.map((task) => task.id);
    const next = sortRank(sortableRows, by);
    const changed = next.filter((task, index) => sortableRows[index]?.id !== task.id).length;
    const unchanged = sortableRows.length - changed;
    if (changed === 0) {
      toast.push(`This list is already sorted by ${label}.`);
      focusSortControl(by);
      return;
    }
    try {
      await api.sortTasks({ listId: sortListId, by });
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      focusSortControl(by);
      const main = changed === 1 ? `Sorted 1 task by ${label}.` : `Sorted ${changed} tasks by ${label}.`;
      const rest = unchanged === 0 ? "" : unchanged === 1 ? " 1 was already in place." : ` ${unchanged} were already in place.`;
      toast.push(`${main}${rest}`, {
        label: "Undo",
        run: () => {
          if (!navigator.onLine) {
            toast.push("You are offline. Reconnect to restore the previous order.");
            focusSortControl(by);
            return;
          }
          void api
            .reorderTasks(previousIds)
            .then(() => {
              toast.push(previousIds.length === 1 ? "Restored the order of 1 task." : `Restored the order of ${previousIds.length} tasks.`);
              focusSortControl(by);
              return queryClient.invalidateQueries({ queryKey: ["tasks"] });
            })
            .catch((error: unknown) => {
              void queryClient.invalidateQueries({ queryKey: ["tasks"] });
              toast.push(error instanceof ApiError ? error.message : "Could not restore the previous order.");
              focusSortControl(by);
            });
        },
      });
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not sort the list.");
      focusSortControl(by);
    }
  }

  async function addTask() {
    const focusQuickAdd = () =>
      queueMicrotask(() => {
        const target = document.getElementById("quick-add") ?? document.getElementById("workspace-heading");
        target?.focus();
      });
    const title = draftTitle.trim();
    if (!title) {
      focusQuickAdd();
      return;
    }
    const inbox = (lists.data ?? []).find((list) => list.isInbox);
    const body: Record<string, unknown> = {
      title,
      listId: view.kind === "list" ? view.listId : inbox?.id,
    };
    if (view.kind === "tag") body.tagIds = [view.tagId];
    if (view.kind === "today" && me.data) {
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: me.data.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      body.dueAt = combineDateAndTime(today, null, me.data.timeZone).dueAt;
      body.dueHasTime = false;
    }
    try {
      const result = await sync.queueCreate(body);
      setDraftTitle("");
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      const createdId = result.id;
      if ("queued" in result && result.queued) {
        toast.push("Saved on this device. It will sync when you reconnect.", {
          label: "Undo",
          run: () => {
            void sync
              .cancelQueuedCreate(createdId)
              .then(() => {
                toast.push("Removed the task.");
                focusQuickAdd();
                return queryClient.invalidateQueries({ queryKey: ["tasks"] });
              })
              .catch((error: unknown) => {
                void queryClient.invalidateQueries({ queryKey: ["tasks"] });
                toast.push(error instanceof ApiError ? error.message : "Could not remove the task.");
                focusQuickAdd();
              });
          },
        });
        focusQuickAdd();
        return;
      }
      toast.push("Task added.", {
        label: "Undo",
        run: () => {
          if (!navigator.onLine) {
            toast.push("You are offline. Reconnect to remove that task.");
            focusQuickAdd();
            return;
          }
          void api
            .deleteTask(createdId)
            .then(() => {
              toast.push("Removed the task.");
              focusQuickAdd();
              return queryClient.invalidateQueries({ queryKey: ["tasks"] });
            })
            .catch((error: unknown) => {
              void queryClient.invalidateQueries({ queryKey: ["tasks"] });
              toast.push(error instanceof ApiError ? error.message : "Could not remove the task.");
              focusQuickAdd();
            });
        },
      });
      focusQuickAdd();
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not add the task.");
      focusQuickAdd();
    }
  }

  async function onDragEnd(event: DragEndEvent) {
    if (!sortable || !event.over || event.active.id === event.over.id) return;
    const activeId = String(event.active.id);
    const focusTask = () =>
      queueMicrotask(() => {
        const control = document.getElementById(`task-open-${activeId}`);
        if (control) control.focus();
        else document.getElementById("workspace-heading")?.focus();
      });
    if (!online) {
      toast.push("You are offline. Reconnect to reorder tasks.");
      focusTask();
      return;
    }
    const ids = rows.map((task) => task.id);
    const from = ids.indexOf(activeId);
    const to = ids.indexOf(String(event.over.id));
    if (from < 0 || to < 0) return;
    const next = arrayMove(ids, from, to);
    const changed = next.filter((id, index) => ids[index] !== id).length;
    if (changed === 0) return;
    try {
      await api.reorderTasks(next);
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      const unchanged = ids.length - changed;
      const main = changed === 1 ? "Reordered 1 task." : `Reordered ${changed} tasks.`;
      const rest = unchanged === 0 ? "" : unchanged === 1 ? " 1 was already in place." : ` ${unchanged} were already in place.`;
      toast.push(`${main}${rest}`, {
        label: "Undo",
        run: () => {
          if (!navigator.onLine) {
            toast.push("You are offline. Reconnect to restore the previous order.");
            focusTask();
            return;
          }
          void api
            .reorderTasks(ids)
            .then(() => {
              toast.push("Restored the previous order.");
              focusTask();
              return queryClient.invalidateQueries({ queryKey: ["tasks"] });
            })
            .catch((error: unknown) => {
              void queryClient.invalidateQueries({ queryKey: ["tasks"] });
              toast.push(error instanceof ApiError ? error.message : "Could not reorder tasks.");
              focusTask();
            });
        },
      });
      focusTask();
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not reorder tasks.");
      focusTask();
    }
  }

  async function moveSelected() {
    const focusMove = () => focusSelectionControl("move-selected");
    if (!online) {
      toast.push("You are offline. Reconnect to move the selection.");
      focusMove();
      return;
    }
    if (!moveTo) return;
    const ids = chosenIds();
    try {
      const selected = rows.filter((task) => ids.includes(task.id));
      const result = await api.batchTasks({ ids, action: "move", listId: moveTo });
      clearListSelection();
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      const returnedIds = result.tasks.map((task) => task.id);
      let changed = 0;
      let already = 0;
      let blocked = 0;
      for (const task of result.tasks) {
        const before = selected.find((row) => row.id === task.id);
        if (!before) {
          changed += 1;
          continue;
        }
        if (before.revision !== task.revision) {
          changed += 1;
          continue;
        }
        const neededDetach = Boolean(before.parentId && !ids.includes(before.parentId));
        const neededLeave = before.listId !== moveTo;
        if (!neededLeave && !neededDetach) already += 1;
        else blocked += 1;
      }
      const selectedSubtasks = changed > 0 && ids.some((id) => !returnedIds.includes(id));
      const changedRows = selected.filter((task) => {
        const after = result.tasks.find((row) => row.id === task.id);
        return Boolean(after && after.revision !== task.revision);
      });
      const carried = selectedSubtasks ? 0 : changedRows.reduce((sum, task) => sum + (task.subtaskCount ?? 0), 0);
      const extra = selectedSubtasks
        ? changed === 1
          ? " Its selected subtasks went with it."
          : " Selected subtasks went with them."
        : carried === 0
          ? ""
          : changed === 1
            ? carried === 1
              ? " Its subtask moved too."
              : " Its subtasks moved too."
            : " Their subtasks moved too.";
      const main =
        changed === 0
          ? blocked > 0 && already === 0
            ? blocked === 1
              ? "That task belongs to someone else."
              : "Those tasks belong to someone else."
            : already === 1
              ? "That task is already on that list."
              : "Those tasks are already on that list."
          : changed === 1
            ? "Moved 1 task."
            : `Moved ${changed} tasks.`;
      const alreadyRest =
        changed === 0 || already === 0
          ? ""
          : already === 1
            ? " 1 was already on that list."
            : ` ${already} were already on that list.`;
      const blockedRest =
        changed === 0 || blocked === 0
          ? ""
          : blocked === 1
            ? " 1 belongs to someone else."
            : ` ${blocked} belong to someone else.`;
      if (changed === 0) {
        toast.push(`${main}${alreadyRest}${blockedRest}${extra}`);
        focusMove();
        return;
      }
      const previousByList = new Map<string, string[]>();
      for (const task of changedRows) {
        const group = previousByList.get(task.listId) ?? [];
        group.push(task.id);
        previousByList.set(task.listId, group);
      }
      toast.push(`${main}${alreadyRest}${blockedRest}${extra}`, {
        label: "Undo",
        run: () => {
          if (!navigator.onLine) {
            toast.push("You are offline. Reconnect to move the selection back.");
            focusMove();
            return;
          }
          void (async () => {
            try {
              let brought = 0;
              for (const [listId, undoIds] of previousByList) {
                const restored = await api.batchTasks({ ids: undoIds, action: "move", listId });
                brought += restored.tasks.filter((task) => task.listId === listId).length;
              }
              const undoMain =
                brought === 0
                  ? "Those tasks are already on that list."
                  : brought === 1
                    ? "Moved 1 task back."
                    : `Moved ${brought} tasks back.`;
              toast.push(undoMain);
              focusMove();
              await queryClient.invalidateQueries({ queryKey: ["tasks"] });
            } catch (error: unknown) {
              void queryClient.invalidateQueries({ queryKey: ["tasks"] });
              toast.push(error instanceof ApiError ? error.message : "Could not move the selection.");
              focusMove();
            }
          })();
        },
      });
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not move the selection.");
      focusMove();
    }
  }

  async function parentSelected() {
    const focusParent = () => focusSelectionControl("parent-selected");
    if (!online) {
      toast.push("You are offline. Reconnect to set the parent.");
      focusParent();
      return;
    }
    if (!parentTo) return;
    const ids = chosenIds();
    try {
      const nextParent = parentTo === "none" ? null : parentTo;
      const selected = rows.filter((task) => ids.includes(task.id));
      const parentRow = nextParent ? rows.find((task) => task.id === nextParent) : null;
      const parentUnusable = Boolean(
        nextParent && (!parentRow || parentRow.status !== "open" || Boolean(parentRow.parentId)),
      );
      const depthBlocked = parentUnusable
        ? selected
        : nextParent
          ? selected.filter((task) => (task.subtaskCount ?? 0) > 0)
          : [];
      const result = await api.batchTasks({ ids, action: "parent", parentId: nextParent });
      clearListSelection();
      setParentTo("");
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      let changed = 0;
      let already = 0;
      let skipped = 0;
      let ownedBlocked = 0;
      for (const task of selected) {
        const after = result.tasks.find((row) => row.id === task.id);
        if (!after) continue;
        if (depthBlocked.some((item) => item.id === task.id) || parentUnusable) {
          skipped += 1;
          continue;
        }
        if (after.revision !== task.revision) {
          changed += 1;
          continue;
        }
        if ((task.parentId ?? null) === nextParent) already += 1;
        else ownedBlocked += 1;
      }
      const clearing = nextParent === null;
      const blockedOnly = skipped + ownedBlocked;
      const main =
        changed === 0
          ? blockedOnly > 0 && already === 0
            ? blockedOnly === 1
              ? parentUnusable
                ? "That task cannot become a subtask of that task."
                : ownedBlocked === 1 && skipped === 0
                  ? "That task belongs to someone else."
                  : "That task already has subtasks."
              : parentUnusable
                ? "Those tasks cannot become subtasks of that task."
                : ownedBlocked > 0 && skipped === 0
                  ? "Those tasks belong to someone else."
                  : "Those tasks already have subtasks."
            : already === 1
              ? clearing
                ? "That task is already on its own."
                : "That task is already a subtask of that task."
              : clearing
                ? "Those tasks are already on their own."
                : "Those tasks are already subtasks of that task."
          : clearing
            ? changed === 1
              ? "1 task is on its own."
              : `${changed} tasks are on their own.`
            : changed === 1
              ? "1 task is now a subtask."
              : `${changed} tasks are now subtasks.`;
      const alreadyRest =
        changed === 0 || already === 0
          ? ""
          : already === 1
            ? clearing
              ? " 1 was already on its own."
              : " 1 was already a subtask of that task."
            : clearing
              ? ` ${already} were already on their own.`
              : ` ${already} were already subtasks of that task.`;
      const skippedRest =
        changed === 0 || skipped === 0
          ? ""
          : skipped === 1
            ? parentUnusable
              ? " 1 cannot become a subtask of that task."
              : " 1 already has subtasks."
            : parentUnusable
              ? ` ${skipped} cannot become subtasks of that task.`
              : ` ${skipped} already have subtasks.`;
      const ownedRest =
        changed === 0 || ownedBlocked === 0
          ? ""
          : ownedBlocked === 1
            ? " 1 belongs to someone else."
            : ` ${ownedBlocked} belong to someone else.`;
      if (changed === 0) {
        toast.push(`${main}${alreadyRest}${skippedRest}${ownedRest}`);
        focusParent();
        return;
      }
      const previousByParent = new Map<string, string[]>();
      for (const task of selected) {
        const after = result.tasks.find((row) => row.id === task.id);
        if (!after || after.revision === task.revision) continue;
        if (depthBlocked.some((item) => item.id === task.id) || parentUnusable) continue;
        const key = task.parentId ?? "";
        const group = previousByParent.get(key) ?? [];
        group.push(task.id);
        previousByParent.set(key, group);
      }
      toast.push(`${main}${alreadyRest}${skippedRest}${ownedRest}`, {
        label: "Undo",
        run: () => {
          if (!navigator.onLine) {
            toast.push("You are offline. Reconnect to restore the previous parents.");
            focusParent();
            return;
          }
          void (async () => {
            try {
              let brought = 0;
              for (const [key, undoIds] of previousByParent) {
                const previous = key === "" ? null : key;
                const restored = await api.batchTasks({ ids: undoIds, action: "parent", parentId: previous });
                brought += restored.tasks.filter((task) => (task.parentId ?? null) === previous).length;
              }
              const undoMain =
                brought === 0
                  ? "Those tasks are already under that parent."
                  : brought === 1
                    ? "Restored the parent on 1 task."
                    : `Restored the parent on ${brought} tasks.`;
              toast.push(undoMain);
              focusParent();
              await queryClient.invalidateQueries({ queryKey: ["tasks"] });
            } catch (error: unknown) {
              void queryClient.invalidateQueries({ queryKey: ["tasks"] });
              toast.push(error instanceof ApiError ? error.message : "Could not change the parent.");
              focusParent();
            }
          })();
        },
      });
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not change the parent.");
      focusParent();
    }
  }

  async function clearCompleted() {
    const focusClear = () => focusSelectionControl("clear-completed");
    if (!online) {
      toast.push("You are offline. Reconnect to clear completed tasks.");
      focusClear();
      return;
    }
    try {
      const result = await api.clearCompleted();
      setChecked([]);
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      focusClear();
      if (result.deleted === 0 && result.kept > 0) {
        toast.push("The remaining tasks were added by someone else.");
        return;
      }
      if (result.deleted === 0) {
        toast.push("No completed tasks to clear.");
        return;
      }
      const moved = result.deleted === 1 ? "Moved 1 completed task to Trash." : `Moved ${result.deleted} completed tasks to Trash.`;
      const stayed =
        result.kept === 1 ? " 1 stays because someone else added it." : result.kept > 1 ? ` ${result.kept} stay because someone else added them.` : "";
      const roots = result.deletedIds;
      toast.push(`${moved}${stayed}`, {
        label: "Undo",
        run: () => {
          if (!navigator.onLine) {
            toast.push("You are offline. Reconnect to restore those tasks.");
            focusClear();
            return;
          }
          void api
            .restoreSelected(roots)
            .then((restored) => {
              const count = restored.restored;
              const main = count === 1 ? "Restored 1 task." : `Restored ${count} tasks.`;
              const skipped =
                restored.skipped === 1
                  ? " 1 was already open."
                  : restored.skipped > 1
                    ? ` ${restored.skipped} were already open.`
                    : "";
              toast.push(`${main}${skipped}`);
              focusClear();
              return queryClient.invalidateQueries({ queryKey: ["tasks"] });
            })
            .catch((error: unknown) => {
              void queryClient.invalidateQueries({ queryKey: ["tasks"] });
              toast.push(error instanceof ApiError ? error.message : "Could not restore the tasks.");
              focusClear();
            });
        },
      });
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not clear completed tasks.");
      focusClear();
    }
  }

  async function setSelectedReminder(minutes: number | null) {
    const focusReminder = () => focusSelectionControl("reminder-selected");
    if (!online) {
      toast.push("You are offline. Reconnect to set the reminder.");
      focusReminder();
      return;
    }
    const ids = chosenIds();
    try {
      const selected = rows.filter((task) => ids.includes(task.id));
      const clearing = minutes === null;
      const result = await api.batchTasks({ ids, action: "remind", reminderOffsetMinutes: minutes });
      clearListSelection();
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      const changedTasks = result.tasks.filter((task) => {
        const before = selected.find((row) => row.id === task.id);
        return Boolean(
          before &&
            before.status === "open" &&
            (clearing || before.dueAt) &&
            (before.reminderOffsetMinutes ?? null) !== minutes &&
            (task.reminderOffsetMinutes ?? null) === minutes,
        );
      });
      const changed = changedTasks.length;
      const skipped = result.tasks.filter((task) => {
        const before = selected.find((row) => row.id === task.id);
        if (!before) return false;
        if (before.status !== "open") return true;
        return !clearing && !before.dueAt;
      }).length;
      const already = result.tasks.length - changed - skipped;
      const main =
        changed === 0
          ? skipped > 0 && already === 0
            ? skipped === 1
              ? clearing
                ? "That task is finished."
                : "That task needs a due date."
              : clearing
                ? "Those tasks are finished."
                : "Those tasks need a due date."
            : already === 1
              ? clearing
                ? "That task already has no reminder."
                : "That task already has that reminder."
              : clearing
                ? "Those tasks already have no reminder."
                : "Those tasks already have that reminder."
          : clearing
            ? changed === 1
              ? "Cleared the reminder on 1 task."
              : `Cleared the reminder on ${changed} tasks.`
            : changed === 1
              ? "Set a reminder on 1 task."
              : `Set a reminder on ${changed} tasks.`;
      const alreadyRest =
        changed === 0 || already === 0
          ? ""
          : already === 1
            ? clearing
              ? " 1 already had no reminder."
              : " 1 already had that reminder."
            : clearing
              ? ` ${already} already had no reminder.`
              : ` ${already} already had that reminder.`;
      const skippedRest =
        changed === 0 || skipped === 0
          ? ""
          : skipped === 1
            ? clearing
              ? " 1 is finished."
              : " 1 needs a due date."
            : clearing
              ? ` ${skipped} are finished.`
              : ` ${skipped} need a due date.`;
      if (changed === 0) {
        toast.push(`${main}${alreadyRest}${skippedRest}`);
        focusReminder();
        return;
      }
      const previousByReminder = new Map<string, string[]>();
      for (const task of changedTasks) {
        const before = selected.find((row) => row.id === task.id);
        if (!before) continue;
        const key =
          before.reminderOffsetMinutes === null || before.reminderOffsetMinutes === undefined
            ? ""
            : String(before.reminderOffsetMinutes);
        const group = previousByReminder.get(key) ?? [];
        group.push(task.id);
        previousByReminder.set(key, group);
      }
      toast.push(`${main}${alreadyRest}${skippedRest}`, {
        label: "Undo",
        run: () => {
          if (!navigator.onLine) {
            toast.push("You are offline. Reconnect to restore the previous reminders.");
            focusReminder();
            return;
          }
          void (async () => {
            try {
              let brought = 0;
              for (const [key, undoIds] of previousByReminder) {
                const previous = key === "" ? null : Number(key);
                const restored = await api.batchTasks({
                  ids: undoIds,
                  action: "remind",
                  reminderOffsetMinutes: previous,
                });
                brought += restored.tasks.filter((task) => (task.reminderOffsetMinutes ?? null) === previous).length;
              }
              const undoMain =
                brought === 0
                  ? "Those tasks already have that reminder."
                  : brought === 1
                    ? "Restored the reminder on 1 task."
                    : `Restored the reminder on ${brought} tasks.`;
              toast.push(undoMain);
              focusReminder();
              await queryClient.invalidateQueries({ queryKey: ["tasks"] });
            } catch (error: unknown) {
              void queryClient.invalidateQueries({ queryKey: ["tasks"] });
              toast.push(error instanceof ApiError ? error.message : "Could not set the reminder.");
              focusReminder();
            }
          })();
        },
      });
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not set the reminder.");
      focusReminder();
    }
  }

  async function setSelectedTag(tagMode: "add" | "remove") {
    const focusTag = () =>
      focusSelectionControl(tagMode === "add" ? "add-tag-selected" : "remove-tag-selected");
    if (!online) {
      toast.push(tagMode === "add" ? "You are offline. Reconnect to add that tag." : "You are offline. Reconnect to remove that tag.");
      focusTag();
      return;
    }
    if (!tagTo) return;
    const ids = chosenIds();
    try {
      const selected = rows.filter((task) => ids.includes(task.id));
      const result = await api.batchTasks({ ids, action: "tag", tagId: tagTo, tagMode });
      clearListSelection();
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      const hasTag = (task: { tagIds?: string[] }) => (task.tagIds ?? []).includes(tagTo);
      const adding = tagMode === "add";
      const changedTasks = result.tasks.filter((task) => {
        const before = selected.find((row) => row.id === task.id);
        if (!before) return false;
        return adding ? !hasTag(before) && hasTag(task) : hasTag(before) && !hasTag(task);
      });
      const changed = changedTasks.length;
      const unchanged = result.tasks.length - changed;
      const main =
        changed === 0
          ? unchanged === 1
            ? adding
              ? "That task already has that tag."
              : "That task does not have that tag."
            : adding
              ? "Those tasks already have that tag."
              : "Those tasks do not have that tag."
          : adding
            ? changed === 1
              ? "Tagged 1 task."
              : `Tagged ${changed} tasks.`
            : changed === 1
              ? "Removed the tag from 1 task."
              : `Removed the tag from ${changed} tasks.`;
      const rest =
        changed === 0 || unchanged === 0
          ? ""
          : unchanged === 1
            ? adding
              ? " 1 already had that tag."
              : " 1 did not have that tag."
            : adding
              ? ` ${unchanged} already had that tag.`
              : ` ${unchanged} did not have that tag.`;
      const undoIds = changedTasks.map((task) => task.id);
      const undoMode = adding ? "remove" : "add";
      if (changed === 0) {
        toast.push(`${main}${rest}`);
        focusTag();
        return;
      }
      toast.push(`${main}${rest}`, {
        label: "Undo",
        run: () => {
          if (!navigator.onLine) {
            toast.push(undoMode === "add" ? "You are offline. Reconnect to add that tag." : "You are offline. Reconnect to remove that tag.");
            focusTag();
            return;
          }
          void api
            .batchTasks({ ids: undoIds, action: "tag", tagId: tagTo, tagMode: undoMode })
            .then((restored) => {
              const brought = restored.tasks.filter((task) => (adding ? !hasTag(task) : hasTag(task))).length;
              const undoMain =
                brought === 0
                  ? adding
                    ? "Those tasks do not have that tag."
                    : "Those tasks already have that tag."
                  : adding
                    ? brought === 1
                      ? "Removed the tag from 1 task."
                      : `Removed the tag from ${brought} tasks.`
                    : brought === 1
                      ? "Tagged 1 task."
                      : `Tagged ${brought} tasks.`;
              toast.push(undoMain);
              focusTag();
              return queryClient.invalidateQueries({ queryKey: ["tasks"] });
            })
            .catch((error: unknown) => {
              void queryClient.invalidateQueries({ queryKey: ["tasks"] });
              toast.push(
                error instanceof ApiError
                  ? error.message
                  : undoMode === "add"
                    ? "Could not add that tag."
                    : "Could not remove that tag.",
              );
              focusTag();
            });
        },
      });
    } catch (error) {
      toast.push(
        error instanceof ApiError
          ? error.message
          : tagMode === "add"
            ? "Could not add that tag."
            : "Could not remove that tag.",
      );
      focusTag();
    }
  }

  function applySelectedEstimate() {
    if (estimateTo.trim() === "") return;
    const minutes = Number(estimateTo);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 100000) {
      toast.push("Choose a whole number of minutes.");
      focusSelectionControl("estimate-selected");
      return;
    }
    void setSelectedEstimate(minutes);
  }

  async function omitSelected() {
    const focusOmit = () => focusSelectionControl("omit-selected");
    if (!online) {
      toast.push("You are offline. Reconnect to remove this date.");
      focusOmit();
      return;
    }
    const ids = chosenIds();
    if (ids.length === 0) return;
    try {
      const selected = new Set(ids);
      const roots = rows.filter((task) => ids.includes(task.id) && (!task.parentId || !selected.has(task.parentId)));
      const beforeById = new Map(roots.map((task) => [task.id, task]));
      const result = await api.batchTasks({ ids, action: "omit" });
      clearListSelection();
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      const changedTasks = result.tasks.filter((task) => {
        const before = beforeById.get(task.id);
        if (!before || before.status !== "open" || !before.recurrence || !before.dueAt) return false;
        return (
          (before.dueAt ?? null) !== (task.dueAt ?? null) ||
          before.status !== task.status ||
          Boolean(before.recurrence) !== Boolean(task.recurrence)
        );
      });
      const changed = changedTasks.length;
      const unchanged = result.tasks.length - changed;
      const main =
        changed === 0
          ? unchanged === 1
            ? "That task does not repeat."
            : "Those tasks do not repeat."
          : changed === 1
            ? "Removed this date from 1 task."
            : `Removed this date from ${changed} tasks.`;
      const rest =
        changed === 0 || unchanged === 0
          ? ""
          : unchanged === 1
            ? " 1 does not repeat."
            : ` ${unchanged} do not repeat.`;
      const undoIds = changedTasks.map((task) => task.id);
      if (changed === 0) {
        toast.push(`${main}${rest}`);
        focusOmit();
        return;
      }
      toast.push(`${main}${rest}`, {
        label: "Undo",
        run: () => {
          if (!navigator.onLine) {
            toast.push("You are offline. Reconnect to restore this date.");
            focusOmit();
            return;
          }
          void (async () => {
            try {
              let brought = 0;
              for (const id of undoIds) {
                await api.restoreOmittedOccurrence(id);
                brought += 1;
              }
              toast.push(
                brought === 0
                  ? "Those dates are already restored."
                  : brought === 1
                    ? "Restored 1 removed date."
                    : `Restored ${brought} removed dates.`,
              );
              await queryClient.invalidateQueries({ queryKey: ["tasks"] });
            } catch (error: unknown) {
              void queryClient.invalidateQueries({ queryKey: ["tasks"] });
              toast.push(error instanceof ApiError ? error.message : "Could not remove this date.");
              focusOmit();
            }
          })();
        },
      });
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not remove this date.");
      focusOmit();
    }
  }

  async function skipSelected() {
    const focusSkip = () => focusSelectionControl("skip-selected");
    if (!online) {
      toast.push("You are offline. Reconnect to skip the selection.");
      focusSkip();
      return;
    }
    const ids = chosenIds();
    if (ids.length === 0) return;
    try {
      const selected = new Set(ids);
      const roots = rows.filter((task) => ids.includes(task.id) && (!task.parentId || !selected.has(task.parentId)));
      const result = await api.batchTasks({ ids, action: "skip" });
      clearListSelection();
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      const changedTasks = result.tasks.filter((task) => {
        const before = roots.find((row) => row.id === task.id);
        if (!before || before.status !== "open" || !before.recurrence || !before.dueAt) return false;
        return (
          (before.dueAt ?? null) !== (task.dueAt ?? null) ||
          before.status !== task.status ||
          Boolean(before.recurrence) !== Boolean(task.recurrence)
        );
      });
      const changed = changedTasks.length;
      const unchanged = result.tasks.length - changed;
      const main =
        changed === 0
          ? unchanged === 1
            ? "That task does not repeat."
            : "Those tasks do not repeat."
          : changed === 1
            ? "Skipped 1 task."
            : `Skipped ${changed} tasks.`;
      const rest =
        changed === 0 || unchanged === 0
          ? ""
          : unchanged === 1
            ? " 1 does not repeat."
            : ` ${unchanged} do not repeat.`;
      if (changed === 0) {
        toast.push(`${main}${rest}`);
        focusSkip();
        return;
      }
      const undoIds = changedTasks.map((task) => task.id);
      toast.push(`${main}${rest}`, {
        label: "Undo",
        run: () => {
          if (!navigator.onLine) {
            toast.push("You are offline. Reconnect to restore the skipped dates.");
            focusSkip();
            return;
          }
          void (async () => {
            try {
              let brought = 0;
              for (const id of undoIds) {
                await api.uncompleteTask(id);
                brought += 1;
              }
              const undoMain =
                brought === 0
                  ? "Those tasks already have that date."
                  : brought === 1
                    ? "Restored 1 skipped date."
                    : `Restored ${brought} skipped dates.`;
              toast.push(undoMain);
              focusSkip();
              await queryClient.invalidateQueries({ queryKey: ["tasks"] });
            } catch (error: unknown) {
              void queryClient.invalidateQueries({ queryKey: ["tasks"] });
              toast.push(error instanceof ApiError ? error.message : "Could not restore the skipped dates.");
              focusSkip();
            }
          })();
        },
      });
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not skip the selection.");
      focusSkip();
    }
  }

  async function archiveSelected() {
    const focusArchive = () => focusSelectionControl("archive-selected");
    if (!online) {
      toast.push("You are offline. Reconnect to archive the selection.");
      focusArchive();
      return;
    }
    const ids = chosenIds();
    if (ids.length === 0) return;
    try {
      const selected = new Set(ids);
      const roots = rows.filter((task) => ids.includes(task.id) && (!task.parentId || !selected.has(task.parentId)));
      const result = await api.batchTasks({ ids, action: "archive" });
      clearListSelection();
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      const changedTasks = result.tasks.filter((task) => {
        const before = roots.find((row) => row.id === task.id);
        return Boolean(before && before.status !== "archived" && task.status === "archived");
      });
      const changed = changedTasks.length;
      const unchanged = result.tasks.length - changed;
      const selectedSubtasks = ids.some((id) => {
        const row = rows.find((task) => task.id === id);
        return Boolean(row?.parentId && changedTasks.some((task) => task.id === row.parentId));
      });
      const carried = selectedSubtasks
        ? 0
        : changedTasks.reduce((sum, task) => {
            const before = roots.find((row) => row.id === task.id);
            return sum + (before?.subtaskCount ?? 0);
          }, 0);
      const main =
        changed === 0
          ? unchanged === 1
            ? "That task is already archived."
            : "Those tasks are already archived."
          : changed === 1
            ? "Archived 1 task."
            : `Archived ${changed} tasks.`;
      const rest =
        changed === 0 || unchanged === 0
          ? ""
          : unchanged === 1
            ? " 1 was already archived."
            : ` ${unchanged} were already archived.`;
      const extra =
        changed === 0
          ? ""
          : selectedSubtasks
            ? changed === 1
              ? " Its selected subtasks went with it."
              : " Selected subtasks went with them."
            : carried === 0
              ? ""
              : changed === 1
                ? carried === 1
                  ? " Its subtask was archived too."
                  : " Its subtasks were archived too."
                : " Their subtasks were archived too.";
      const undoIds = changedTasks.map((task) => task.id);
      if (changed === 0) {
        toast.push(`${main}${rest}${extra}`);
        focusArchive();
        return;
      }
      toast.push(`${main}${rest}${extra}`, {
        label: "Undo",
        run: () => {
          if (!navigator.onLine) {
            toast.push("You are offline. Reconnect to unarchive the selection.");
            focusArchive();
            return;
          }
          void api
            .batchTasks({ ids: undoIds, action: "unarchive" })
            .then((restored) => {
              const brought = restored.tasks.filter((task) => task.status !== "archived").length;
              const skipped = restored.tasks.length - brought;
              const undoMain = brought === 1 ? "Restored 1 task." : `Restored ${brought} tasks.`;
              const undoRest =
                brought === 0
                  ? skipped === 1
                    ? "That task is already open."
                    : "Those tasks are already open."
                  : skipped === 0
                    ? ""
                    : skipped === 1
                      ? " 1 was already open."
                      : ` ${skipped} were already open.`;
              toast.push(brought === 0 ? undoRest : `${undoMain}${undoRest}`);
              focusArchive();
              return queryClient.invalidateQueries({ queryKey: ["tasks"] });
            })
            .catch((error: unknown) => {
              void queryClient.invalidateQueries({ queryKey: ["tasks"] });
              toast.push(error instanceof ApiError ? error.message : "Could not unarchive the selection.");
              focusArchive();
            });
        },
      });
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not archive the selection.");
      focusArchive();
    }
  }

  async function duplicateSelected() {
    const focusDuplicate = () => focusSelectionControl("duplicate-selected");
    if (!online) {
      toast.push("You are offline. Reconnect to duplicate the selection.");
      focusDuplicate();
      return;
    }
    const ids = chosenIds();
    if (ids.length === 0) return;
    try {
      const result = await api.batchTasks({ ids, action: "duplicate" });
      clearListSelection();
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      const count = result.tasks.length;
      const copied = result.tasks.reduce((sum, task) => sum + (task.subtaskCount ?? 0), 0);
      const extra =
        copied === 0
          ? ""
          : count === 1
            ? copied === 1
              ? " Its subtask was copied too."
              : " Its subtasks were copied too."
            : " Their subtasks were copied too.";
      const copyIds = result.tasks.map((task) => task.id);
      toast.push(`${count === 1 ? "Duplicated 1 task." : `Duplicated ${count} tasks.`}${extra}`, {
        label: "Undo",
        run: () => {
          if (!navigator.onLine) {
            toast.push("You are offline. Reconnect to remove those copies.");
            focusDuplicate();
            return;
          }
          void api
            .batchTasks({ ids: copyIds, action: "delete" })
            .then((deleted) => {
              const removed = deleted.tasks.length;
              toast.push(removed === 1 ? "Removed 1 duplicate." : `Removed ${removed} duplicates.`);
              focusDuplicate();
              return queryClient.invalidateQueries({ queryKey: ["tasks"] });
            })
            .catch((error: unknown) => {
              void queryClient.invalidateQueries({ queryKey: ["tasks"] });
              toast.push(error instanceof ApiError ? error.message : "Could not remove the duplicates.");
              focusDuplicate();
            });
        },
      });
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not duplicate the selection.");
      focusDuplicate();
    }
  }

  async function repeatSelected() {
    const focusRepeat = () => focusSelectionControl("repeat-selected");
    if (!online) {
      toast.push("You are offline. Reconnect to set the repeat rule.");
      focusRepeat();
      return;
    }
    if (repeatTo === "") return;
    const ids = chosenIds();
    if (ids.length === 0) return;
    const interval = Number(repeatEvery);
    if (repeatTo !== "none" && (!Number.isInteger(interval) || interval < 1 || interval > 99)) {
      toast.push("Choose a whole number from 1 to 99.");
      focusSelectionControl("repeat-every-selected");
      return;
    }
    let count: number | undefined;
    if (repeatTo !== "none" && repeatCount.trim() !== "") {
      count = Number(repeatCount);
      if (!Number.isInteger(count) || count < 1 || count > 999) {
        toast.push("Choose how many times it repeats, from 1 to 999.");
        focusSelectionControl("repeat-count-selected");
        return;
      }
    }
    let until: string | undefined;
    if (repeatTo !== "none" && repeatUntil) {
      if (!me.data) return;
      try {
        until = combineDateAndTime(repeatUntil, "23:59", me.data.timeZone).dueAt;
      } catch {
        toast.push("Choose a valid end date.");
        focusSelectionControl("repeat-until-selected");
        return;
      }
    }
    const recurrence =
      repeatTo === "none"
        ? null
        : {
            frequency: repeatTo as "daily" | "weekly" | "monthly" | "yearly",
            interval,
            ...(repeatTo === "weekly" && weekdays.length > 0 ? { byWeekday: [...weekdays].sort((left, right) => left - right) } : {}),
            ...(count ? { count } : {}),
            ...(until ? { until } : {}),
          };
    try {
      const selected = rows.filter((task) => ids.includes(task.id));
      const untilAt = until ? new Date(until).getTime() : null;
      const result = await api.batchTasks({ ids, action: "repeat", recurrence });
      clearListSelection();
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      const clearing = recurrence === null;
      const canTakeRule = (task: (typeof selected)[number]) => {
        if (task.status !== "open") return false;
        if (recurrence === null) return true;
        if (!task.dueAt) return false;
        if (untilAt !== null && new Date(task.dueAt).getTime() > untilAt) return false;
        return true;
      };
      const changedTasks = result.tasks.filter((task) => {
        const before = selected.find((row) => row.id === task.id);
        return Boolean(before && canTakeRule(before) && !sameRepeat(before.recurrence, recurrence) && sameRepeat(task.recurrence, recurrence));
      });
      const changed = changedTasks.length;
      const already = result.tasks.filter((task) => {
        const before = selected.find((row) => row.id === task.id);
        return Boolean(before && canTakeRule(before) && sameRepeat(before.recurrence, recurrence));
      }).length;
      const skipped = result.tasks.length - changed - already;
      const main =
        changed === 0
          ? skipped > 0 && already === 0
            ? skipped === 1
              ? clearing
                ? "That task is finished."
                : "That task cannot get that repeat rule."
              : clearing
                ? "Those tasks are finished."
                : "Those tasks cannot get that repeat rule."
            : already === 1
              ? clearing
                ? "That task already has no repeat rule."
                : "That task already has that repeat rule."
              : clearing
                ? "Those tasks already have no repeat rule."
                : "Those tasks already have that repeat rule."
          : clearing
            ? changed === 1
              ? "Cleared the repeat rule on 1 task."
              : `Cleared the repeat rule on ${changed} tasks.`
            : changed === 1
              ? "Set the repeat rule on 1 task."
              : `Set the repeat rule on ${changed} tasks.`;
      const alreadyRest =
        changed === 0 || already === 0
          ? ""
          : already === 1
            ? clearing
              ? " 1 already had no repeat rule."
              : " 1 already had that repeat rule."
            : clearing
              ? ` ${already} already had no repeat rule.`
              : ` ${already} already had that repeat rule.`;
      const skippedRest =
        changed === 0 || skipped === 0
          ? ""
          : skipped === 1
            ? clearing
              ? " 1 is finished."
              : " 1 cannot get that repeat rule."
            : clearing
              ? ` ${skipped} are finished.`
              : ` ${skipped} cannot get that repeat rule.`;
      if (changed === 0) {
        toast.push(`${main}${alreadyRest}${skippedRest}`);
        focusRepeat();
        return;
      }
      const previousByRepeat = new Map<string, string[]>();
      for (const task of changedTasks) {
        const before = selected.find((row) => row.id === task.id);
        if (!before) continue;
        const key = encodeRepeat(before.recurrence);
        const group = previousByRepeat.get(key) ?? [];
        group.push(task.id);
        previousByRepeat.set(key, group);
      }
      toast.push(`${main}${alreadyRest}${skippedRest}`, {
        label: "Undo",
        run: () => {
          if (!navigator.onLine) {
            toast.push("You are offline. Reconnect to restore the previous repeat rules.");
            focusRepeat();
            return;
          }
          void (async () => {
            try {
              let brought = 0;
              for (const [key, undoIds] of previousByRepeat) {
                const previous = decodeRepeat(key);
                const restored = await api.batchTasks({ ids: undoIds, action: "repeat", recurrence: previous });
                brought += restored.tasks.filter((task) => sameRepeat(task.recurrence, previous)).length;
              }
              const undoMain =
                brought === 0
                  ? "Those tasks already have that repeat rule."
                  : brought === 1
                    ? "Restored the repeat rule on 1 task."
                    : `Restored the repeat rule on ${brought} tasks.`;
              toast.push(undoMain);
              focusRepeat();
              await queryClient.invalidateQueries({ queryKey: ["tasks"] });
            } catch (error: unknown) {
              void queryClient.invalidateQueries({ queryKey: ["tasks"] });
              toast.push(error instanceof ApiError ? error.message : "Could not set the repeat rule.");
              focusRepeat();
            }
          })();
        },
      });
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not set the repeat rule.");
      focusRepeat();
    }
  }

  async function assignSelected() {
    const focusAssign = () => focusSelectionControl("assign-selected");
    if (!online) {
      toast.push("You are offline. Reconnect to assign the selection.");
      focusAssign();
      return;
    }
    if (assignTo === "") return;
    const ids = chosenIds();
    if (ids.length === 0) return;
    try {
      const nextAssignee = assignTo === "none" ? null : assignTo;
      const selected = rows.filter((task) => ids.includes(task.id));
      const clearing = nextAssignee === null;
      const result = await api.batchTasks({ ids, action: "assign", assigneeId: nextAssignee });
      clearListSelection();
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      const changedTasks = result.tasks.filter((task) => {
        const before = selected.find((row) => row.id === task.id);
        return Boolean(
          before &&
            before.status === "open" &&
            (before.assigneeId ?? null) !== nextAssignee &&
            (task.assigneeId ?? null) === nextAssignee,
        );
      });
      const changed = changedTasks.length;
      const finished = result.tasks.filter((task) => {
        const before = selected.find((row) => row.id === task.id);
        return Boolean(before && before.status !== "open");
      }).length;
      const already = result.tasks.filter((task) => {
        const before = selected.find((row) => row.id === task.id);
        return Boolean(before && before.status === "open" && (before.assigneeId ?? null) === nextAssignee);
      }).length;
      const blocked = result.tasks.length - changed - finished - already;
      const main =
        changed === 0
          ? finished > 0 && already === 0 && blocked === 0
            ? finished === 1
              ? "That task is finished."
              : "Those tasks are finished."
            : blocked > 0 && already === 0 && finished === 0
              ? blocked === 1
                ? "That person is not on that list."
                : "That person is not on those lists."
              : already === 1
                ? clearing
                  ? "That task is already unassigned."
                  : "That task is already assigned to that person."
                : clearing
                  ? "Those tasks are already unassigned."
                  : "Those tasks are already assigned to that person."
          : clearing
            ? changed === 1
              ? "Cleared the assignment on 1 task."
              : `Cleared the assignment on ${changed} tasks.`
            : changed === 1
              ? "Assigned 1 task."
              : `Assigned ${changed} tasks.`;
      const alreadyRest =
        changed === 0 || already === 0
          ? ""
          : already === 1
            ? clearing
              ? " 1 was already unassigned."
              : " 1 was already assigned to that person."
            : clearing
              ? ` ${already} were already unassigned.`
              : ` ${already} were already assigned to that person.`;
      const finishedRest =
        changed === 0 || finished === 0
          ? ""
          : finished === 1
            ? " 1 is finished."
            : ` ${finished} are finished.`;
      const blockedRest =
        changed === 0 || blocked === 0
          ? ""
          : blocked === 1
            ? " 1 is not on that person's list."
            : ` ${blocked} are not on that person's list.`;
      if (changed === 0) {
        toast.push(`${main}${alreadyRest}${finishedRest}${blockedRest}`);
        focusAssign();
        return;
      }
      const previousByAssignee = new Map<string, string[]>();
      for (const task of changedTasks) {
        const before = selected.find((row) => row.id === task.id);
        if (!before) continue;
        const key = before.assigneeId ?? "";
        const group = previousByAssignee.get(key) ?? [];
        group.push(task.id);
        previousByAssignee.set(key, group);
      }
      toast.push(`${main}${alreadyRest}${finishedRest}${blockedRest}`, {
        label: "Undo",
        run: () => {
          if (!navigator.onLine) {
            toast.push("You are offline. Reconnect to restore the previous assignees.");
            focusAssign();
            return;
          }
          void (async () => {
            try {
              let brought = 0;
              for (const [key, undoIds] of previousByAssignee) {
                const previous = key === "" ? null : key;
                const restored = await api.batchTasks({ ids: undoIds, action: "assign", assigneeId: previous });
                brought += restored.tasks.filter((task) => (task.assigneeId ?? null) === previous).length;
              }
              const undoMain =
                brought === 0
                  ? "Those tasks are already assigned that way."
                  : brought === 1
                    ? "Restored the assignment on 1 task."
                    : `Restored the assignment on ${brought} tasks.`;
              toast.push(undoMain);
              focusAssign();
              await queryClient.invalidateQueries({ queryKey: ["tasks"] });
            } catch (error: unknown) {
              void queryClient.invalidateQueries({ queryKey: ["tasks"] });
              toast.push(error instanceof ApiError ? error.message : "Could not assign the selection.");
              focusAssign();
            }
          })();
        },
      });
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not assign the selection.");
      focusAssign();
    }
  }

  async function pinSelected(pinned: boolean) {
    const focusPin = () => focusSelectionControl(pinned ? "pin-selected" : "unpin-selected");
    if (!online) {
      toast.push(pinned ? "You are offline. Reconnect to pin the selection." : "You are offline. Reconnect to unpin the selection.");
      focusPin();
      return;
    }
    const ids = chosenIds();
    if (ids.length === 0) return;
    try {
      const selected = rows.filter((task) => ids.includes(task.id));
      const result = await api.batchTasks({ ids, action: "pin", pinned });
      clearListSelection();
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      const changedTasks = result.tasks.filter((task) => {
        const before = selected.find((row) => row.id === task.id);
        return Boolean(before && before.status === "open" && Boolean(before.pinned) !== pinned && Boolean(task.pinned) === pinned);
      });
      const changed = changedTasks.length;
      const finished = result.tasks.filter((task) => {
        const before = selected.find((row) => row.id === task.id);
        return Boolean(before && before.status !== "open");
      }).length;
      const already = result.tasks.length - changed - finished;
      const main =
        changed === 0
          ? finished > 0 && already === 0
            ? finished === 1
              ? "That task is finished."
              : "Those tasks are finished."
            : already === 1
              ? pinned
                ? "That task is already pinned."
                : "That task is already unpinned."
              : pinned
                ? "Those tasks are already pinned."
                : "Those tasks are already unpinned."
          : pinned
            ? changed === 1
              ? "Pinned 1 task."
              : `Pinned ${changed} tasks.`
            : changed === 1
              ? "Unpinned 1 task."
              : `Unpinned ${changed} tasks.`;
      const alreadyRest =
        changed === 0 || already === 0
          ? ""
          : already === 1
            ? pinned
              ? " 1 was already pinned."
              : " 1 was already unpinned."
            : pinned
              ? ` ${already} were already pinned.`
              : ` ${already} were already unpinned.`;
      const finishedRest =
        changed === 0 || finished === 0
          ? ""
          : finished === 1
            ? " 1 is finished."
            : ` ${finished} are finished.`;
      const undoIds = changedTasks.map((task) => task.id);
      if (changed === 0) {
        toast.push(`${main}${alreadyRest}${finishedRest}`);
        focusPin();
        return;
      }
      toast.push(`${main}${alreadyRest}${finishedRest}`, {
        label: "Undo",
        run: () => {
          if (!navigator.onLine) {
            toast.push(pinned ? "You are offline. Reconnect to unpin the selection." : "You are offline. Reconnect to pin the selection.");
            focusPin();
            return;
          }
          void api
            .batchTasks({ ids: undoIds, action: "pin", pinned: !pinned })
            .then((restored) => {
              const brought = restored.tasks.filter((task) => Boolean(task.pinned) === !pinned).length;
              const skipped = restored.tasks.length - brought;
              const undoMain =
                brought === 0
                  ? ""
                  : pinned
                    ? brought === 1
                      ? "Unpinned 1 task."
                      : `Unpinned ${brought} tasks.`
                    : brought === 1
                      ? "Pinned 1 task."
                      : `Pinned ${brought} tasks.`;
              const undoRest =
                brought === 0
                  ? skipped === 1
                    ? pinned
                      ? "That task is already unpinned."
                      : "That task is already pinned."
                    : pinned
                      ? "Those tasks are already unpinned."
                      : "Those tasks are already pinned."
                  : skipped === 0
                    ? ""
                    : skipped === 1
                      ? pinned
                        ? " 1 was already unpinned."
                        : " 1 was already pinned."
                      : pinned
                        ? ` ${skipped} were already unpinned.`
                        : ` ${skipped} were already pinned.`;
              toast.push(brought === 0 ? undoRest : `${undoMain}${undoRest}`);
              focusPin();
              return queryClient.invalidateQueries({ queryKey: ["tasks"] });
            })
            .catch((error: unknown) => {
              void queryClient.invalidateQueries({ queryKey: ["tasks"] });
              toast.push(
                error instanceof ApiError
                  ? error.message
                  : pinned
                    ? "Could not unpin the selection."
                    : "Could not pin the selection.",
              );
              focusPin();
            });
        },
      });
    } catch (error) {
      toast.push(
        error instanceof ApiError
          ? error.message
          : pinned
            ? "Could not pin the selection."
            : "Could not unpin the selection.",
      );
      focusPin();
    }
  }

  async function setSelectedEstimate(minutes: number | null) {
    const focusEstimate = () => focusSelectionControl("estimate-selected");
    if (!online) {
      toast.push("You are offline. Reconnect to set the estimate.");
      focusEstimate();
      return;
    }
    const ids = chosenIds();
    if (ids.length === 0) return;
    try {
      const selected = rows.filter((task) => ids.includes(task.id));
      const clearing = minutes === null;
      const result = await api.batchTasks({ ids, action: "estimate", estimatedMinutes: minutes });
      clearListSelection();
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      const changedTasks = result.tasks.filter((task) => {
        const before = selected.find((row) => row.id === task.id);
        return Boolean(
          before &&
            before.status === "open" &&
            (before.estimatedMinutes ?? null) !== minutes &&
            (task.estimatedMinutes ?? null) === minutes,
        );
      });
      const changed = changedTasks.length;
      const finished = result.tasks.filter((task) => {
        const before = selected.find((row) => row.id === task.id);
        return Boolean(before && before.status !== "open");
      }).length;
      const already = result.tasks.length - changed - finished;
      const main =
        changed === 0
          ? finished > 0 && already === 0
            ? finished === 1
              ? "That task is finished."
              : "Those tasks are finished."
            : already === 1
              ? clearing
                ? "That task already has no estimate."
                : "That task already has that estimate."
              : clearing
                ? "Those tasks already have no estimate."
                : "Those tasks already have that estimate."
          : clearing
            ? changed === 1
              ? "Cleared the estimate on 1 task."
              : `Cleared the estimate on ${changed} tasks.`
            : changed === 1
              ? "Set the estimate on 1 task."
              : `Set the estimate on ${changed} tasks.`;
      const alreadyRest =
        changed === 0 || already === 0
          ? ""
          : already === 1
            ? clearing
              ? " 1 already had no estimate."
              : " 1 already had that estimate."
            : clearing
              ? ` ${already} already had no estimate.`
              : ` ${already} already had that estimate.`;
      const finishedRest =
        changed === 0 || finished === 0
          ? ""
          : finished === 1
            ? " 1 is finished."
            : ` ${finished} are finished.`;
      if (changed === 0) {
        toast.push(`${main}${alreadyRest}${finishedRest}`);
        focusEstimate();
        return;
      }
      const previousByEstimate = new Map<string, string[]>();
      for (const task of changedTasks) {
        const before = selected.find((row) => row.id === task.id);
        if (!before) continue;
        const key = before.estimatedMinutes === null || before.estimatedMinutes === undefined ? "" : String(before.estimatedMinutes);
        const group = previousByEstimate.get(key) ?? [];
        group.push(task.id);
        previousByEstimate.set(key, group);
      }
      toast.push(`${main}${alreadyRest}${finishedRest}`, {
        label: "Undo",
        run: () => {
          if (!navigator.onLine) {
            toast.push("You are offline. Reconnect to restore the previous estimates.");
            focusEstimate();
            return;
          }
          void (async () => {
            try {
              let brought = 0;
              for (const [key, undoIds] of previousByEstimate) {
                const previous = key === "" ? null : Number(key);
                const restored = await api.batchTasks({ ids: undoIds, action: "estimate", estimatedMinutes: previous });
                brought += restored.tasks.filter((task) => (task.estimatedMinutes ?? null) === previous).length;
              }
              const undoMain =
                brought === 0
                  ? "Those tasks already have that estimate."
                  : brought === 1
                    ? "Restored the estimate on 1 task."
                    : `Restored the estimate on ${brought} tasks.`;
              toast.push(undoMain);
              focusEstimate();
              await queryClient.invalidateQueries({ queryKey: ["tasks"] });
            } catch (error: unknown) {
              void queryClient.invalidateQueries({ queryKey: ["tasks"] });
              toast.push(error instanceof ApiError ? error.message : "Could not set the estimate.");
              focusEstimate();
            }
          })();
        },
      });
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not set the estimate.");
      focusEstimate();
    }
  }

  async function setSelectedStart(startAt: string | null) {
    const focusStart = () => focusSelectionControl("start-selected");
    if (!online) {
      toast.push("You are offline. Reconnect to set the start date.");
      focusStart();
      return;
    }
    const ids = chosenIds();
    if (ids.length === 0) return;
    try {
      const selected = rows.filter((task) => ids.includes(task.id));
      const clearing = startAt === null;
      const result = await api.batchTasks({ ids, action: "start", startAt });
      clearListSelection();
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      const changedTasks = result.tasks.filter((task) => {
        const before = selected.find((row) => row.id === task.id);
        return Boolean(
          before &&
            before.status === "open" &&
            (before.startAt ?? null) !== startAt &&
            (task.startAt ?? null) === startAt,
        );
      });
      const changed = changedTasks.length;
      const finished = result.tasks.filter((task) => {
        const before = selected.find((row) => row.id === task.id);
        return Boolean(before && before.status !== "open");
      }).length;
      const already = result.tasks.length - changed - finished;
      const main =
        changed === 0
          ? finished > 0 && already === 0
            ? finished === 1
              ? "That task is finished."
              : "Those tasks are finished."
            : already === 1
              ? clearing
                ? "That task already has no start date."
                : "That task already has that start date."
              : clearing
                ? "Those tasks already have no start date."
                : "Those tasks already have that start date."
          : clearing
            ? changed === 1
              ? "Cleared the start date on 1 task."
              : `Cleared the start date on ${changed} tasks.`
            : changed === 1
              ? "Set a start date on 1 task."
              : `Set a start date on ${changed} tasks.`;
      const alreadyRest =
        changed === 0 || already === 0
          ? ""
          : already === 1
            ? clearing
              ? " 1 already had no start date."
              : " 1 already had that start date."
            : clearing
              ? ` ${already} already had no start date.`
              : ` ${already} already had that start date.`;
      const finishedRest =
        changed === 0 || finished === 0
          ? ""
          : finished === 1
            ? " 1 is finished."
            : ` ${finished} are finished.`;
      if (changed === 0) {
        toast.push(`${main}${alreadyRest}${finishedRest}`);
        focusStart();
        return;
      }
      const previousByStart = new Map<string, string[]>();
      for (const task of changedTasks) {
        const before = selected.find((row) => row.id === task.id);
        if (!before) continue;
        const key = before.startAt ?? "";
        const group = previousByStart.get(key) ?? [];
        group.push(task.id);
        previousByStart.set(key, group);
      }
      toast.push(`${main}${alreadyRest}${finishedRest}`, {
        label: "Undo",
        run: () => {
          if (!navigator.onLine) {
            toast.push("You are offline. Reconnect to restore the previous start dates.");
            focusStart();
            return;
          }
          void (async () => {
            try {
              let brought = 0;
              for (const [key, undoIds] of previousByStart) {
                const previous = key === "" ? null : key;
                const restored = await api.batchTasks({ ids: undoIds, action: "start", startAt: previous });
                brought += restored.tasks.filter((task) => (task.startAt ?? null) === previous).length;
              }
              const undoMain =
                brought === 0
                  ? "Those tasks already have that start date."
                  : brought === 1
                    ? "Restored the start date on 1 task."
                    : `Restored the start date on ${brought} tasks.`;
              toast.push(undoMain);
              focusStart();
              await queryClient.invalidateQueries({ queryKey: ["tasks"] });
            } catch (error: unknown) {
              void queryClient.invalidateQueries({ queryKey: ["tasks"] });
              toast.push(error instanceof ApiError ? error.message : "Could not set the start date.");
              focusStart();
            }
          })();
        },
      });
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not set the start date.");
      focusStart();
    }
  }

  function applySelectedStart() {
    if (!startOn || !me.data) return;
    try {
      const combined = combineDateAndTime(startOn, null, me.data.timeZone);
      void setSelectedStart(combined.dueAt);
    } catch {
      toast.push("Choose a valid date.");
      focusSelectionControl("start-selected");
    }
  }

  async function setSelectedDue(dueAt: string | null, dueHasTime: boolean) {
    const focusDue = () => focusSelectionControl("due-selected");
    if (!online) {
      toast.push("You are offline. Reconnect to set the due date.");
      focusDue();
      return;
    }
    const ids = chosenIds();
    try {
      const selected = rows.filter((task) => ids.includes(task.id));
      const nextHasTime = Boolean(dueAt) && dueHasTime;
      const clearing = dueAt === null;
      const result = await api.batchTasks({ ids, action: "due", dueAt, dueHasTime });
      clearListSelection();
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      const changedTasks = result.tasks.filter((task) => {
        const before = selected.find((row) => row.id === task.id);
        if (!before || before.status !== "open") return false;
        if (clearing && before.recurrence) return false;
        return (
          ((before.dueAt ?? null) !== dueAt || Boolean(before.dueHasTime) !== nextHasTime) &&
          (task.dueAt ?? null) === dueAt &&
          Boolean(task.dueHasTime) === nextHasTime
        );
      });
      const changed = changedTasks.length;
      const skipped = result.tasks.filter((task) => {
        const before = selected.find((row) => row.id === task.id);
        if (!before) return false;
        if (before.status !== "open") return true;
        return clearing && Boolean(before.recurrence);
      }).length;
      const already = result.tasks.length - changed - skipped;
      const main =
        changed === 0
          ? skipped > 0 && already === 0
            ? skipped === 1
              ? clearing
                ? "That task keeps its date."
                : "That task is finished."
              : clearing
                ? "Those tasks keep their dates."
                : "Those tasks are finished."
            : already === 1
              ? clearing
                ? "That task already has no date."
                : "That task already has that date."
              : clearing
                ? "Those tasks already have no date."
                : "Those tasks already have that date."
          : clearing
            ? changed === 1
              ? "Cleared the date on 1 task."
              : `Cleared the date on ${changed} tasks.`
            : changed === 1
              ? "Dated 1 task."
              : `Dated ${changed} tasks.`;
      const alreadyRest =
        changed === 0 || already === 0
          ? ""
          : already === 1
            ? clearing
              ? " 1 already had no date."
              : " 1 already had that date."
            : clearing
              ? ` ${already} already had no date.`
              : ` ${already} already had that date.`;
      const skippedRest =
        changed === 0 || skipped === 0
          ? ""
          : skipped === 1
            ? clearing
              ? " 1 keeps its date."
              : " 1 is finished."
            : clearing
              ? ` ${skipped} keep their dates.`
              : ` ${skipped} are finished.`;
      if (changed === 0) {
        toast.push(`${main}${alreadyRest}${skippedRest}`);
        focusDue();
        return;
      }
      const previousByDue = new Map<string, string[]>();
      for (const task of changedTasks) {
        const before = selected.find((row) => row.id === task.id);
        if (!before) continue;
        const key = `${before.dueAt ?? ""}|${before.dueHasTime ? 1 : 0}`;
        const group = previousByDue.get(key) ?? [];
        group.push(task.id);
        previousByDue.set(key, group);
      }
      toast.push(`${main}${alreadyRest}${skippedRest}`, {
        label: "Undo",
        run: () => {
          if (!navigator.onLine) {
            toast.push("You are offline. Reconnect to restore the previous due dates.");
            focusDue();
            return;
          }
          void (async () => {
            try {
              let brought = 0;
              for (const [key, undoIds] of previousByDue) {
                const [previousDue, previousHasTime] = key.split("|");
                const due = previousDue === "" ? null : previousDue;
                const hasTime = previousHasTime === "1";
                const restored = await api.batchTasks({
                  ids: undoIds,
                  action: "due",
                  dueAt: due,
                  dueHasTime: hasTime,
                });
                brought += restored.tasks.filter(
                  (task) => (task.dueAt ?? null) === due && Boolean(task.dueHasTime) === Boolean(due && hasTime),
                ).length;
              }
              const undoMain =
                brought === 0
                  ? "Those tasks already have that date."
                  : brought === 1
                    ? "Restored the date on 1 task."
                    : `Restored the date on ${brought} tasks.`;
              toast.push(undoMain);
              focusDue();
              await queryClient.invalidateQueries({ queryKey: ["tasks"] });
            } catch (error: unknown) {
              void queryClient.invalidateQueries({ queryKey: ["tasks"] });
              toast.push(error instanceof ApiError ? error.message : "Could not restore the previous due dates.");
              focusDue();
            }
          })();
        },
      });
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not set the date.");
      focusDue();
    }
  }

  function applySelectedDate() {
    if (!dueOn || !me.data) return;
    try {
      const combined = combineDateAndTime(dueOn, dueAtTime || null, me.data.timeZone);
      void setSelectedDue(combined.dueAt, combined.dueHasTime);
    } catch {
      toast.push("Choose a valid date.");
      focusSelectionControl("due-selected");
    }
  }

  async function setSelectedPriority() {
    const focusPriority = () => focusSelectionControl("priority-selected");
    if (!online) {
      toast.push("You are offline. Reconnect to set the priority.");
      focusPriority();
      return;
    }
    if (!priorityTo) return;
    const ids = chosenIds();
    try {
      const selected = rows.filter((task) => ids.includes(task.id));
      const result = await api.batchTasks({ ids, action: "priority", priority: priorityTo });
      clearListSelection();
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      const changedTasks = result.tasks.filter((task) => {
        const before = selected.find((row) => row.id === task.id);
        return Boolean(before && before.status === "open" && before.priority !== priorityTo && task.priority === priorityTo);
      });
      const changed = changedTasks.length;
      const finished = result.tasks.filter((task) => {
        const before = selected.find((row) => row.id === task.id);
        return Boolean(before && before.status !== "open");
      }).length;
      const already = result.tasks.length - changed - finished;
      const main =
        changed === 0
          ? finished > 0 && already === 0
            ? finished === 1
              ? "That task is finished."
              : "Those tasks are finished."
            : already === 1
              ? "That task already has that priority."
              : "Those tasks already have that priority."
          : changed === 1
            ? "Set the priority on 1 task."
            : `Set the priority on ${changed} tasks.`;
      const alreadyRest =
        changed === 0 || already === 0
          ? ""
          : already === 1
            ? " 1 already had that priority."
            : ` ${already} already had that priority.`;
      const finishedRest =
        changed === 0 || finished === 0
          ? ""
          : finished === 1
            ? " 1 is finished."
            : ` ${finished} are finished.`;
      if (changed === 0) {
        toast.push(`${main}${alreadyRest}${finishedRest}`);
        focusPriority();
        return;
      }
      const previousByPriority = new Map<Priority, string[]>();
      for (const task of changedTasks) {
        const before = selected.find((row) => row.id === task.id);
        if (!before) continue;
        const group = previousByPriority.get(before.priority) ?? [];
        group.push(task.id);
        previousByPriority.set(before.priority, group);
      }
      toast.push(`${main}${alreadyRest}${finishedRest}`, {
        label: "Undo",
        run: () => {
          if (!navigator.onLine) {
            toast.push("You are offline. Reconnect to restore the previous priorities.");
            focusPriority();
            return;
          }
          void (async () => {
            try {
              let brought = 0;
              for (const [priority, undoIds] of previousByPriority) {
                const restored = await api.batchTasks({ ids: undoIds, action: "priority", priority });
                brought += restored.tasks.filter((task) => task.priority === priority).length;
              }
              const undoMain = brought === 1 ? "Restored the priority on 1 task." : `Restored the priority on ${brought} tasks.`;
              toast.push(brought === 0 ? "Those tasks already have that priority." : undoMain);
              focusPriority();
              await queryClient.invalidateQueries({ queryKey: ["tasks"] });
            } catch (error: unknown) {
              void queryClient.invalidateQueries({ queryKey: ["tasks"] });
              toast.push(error instanceof ApiError ? error.message : "Could not set the priority.");
              focusPriority();
            }
          })();
        },
      });
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not set the priority.");
      focusPriority();
    }
  }

  async function postponeSelected() {
    const focusPostpone = () => focusSelectionControl("postpone-selected");
    if (!online) {
      toast.push("You are offline. Reconnect to postpone the selection.");
      focusPostpone();
      return;
    }
    const ids = chosenIds();
    try {
      const selected = new Set(ids);
      const roots = rows.filter(
        (task) =>
          ids.includes(task.id) &&
          (!task.parentId || !selected.has(task.parentId) || Boolean(rows.find((row) => row.id === task.parentId)?.recurrence)),
      );
      const result = await api.batchTasks({ ids, action: "postpone" });
      clearListSelection();
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      const changedTasks = result.tasks.filter((task) => {
        const before = roots.find((row) => row.id === task.id);
        return Boolean(before && before.status === "open" && (before.dueAt ?? null) !== (task.dueAt ?? null));
      });
      const changed = changedTasks.length;
      const unchanged = result.tasks.length - changed;
      const openChildren = changedTasks
        .filter((task) => {
          const before = roots.find((row) => row.id === task.id);
          return Boolean(before && !before.recurrence);
        })
        .reduce((sum, task) => {
          const before = roots.find((row) => row.id === task.id);
          return sum + (before?.openSubtaskCount ?? 0);
        }, 0);
      const main =
        changed === 0
          ? unchanged === 1
            ? "That task is finished."
            : "Those tasks are finished."
          : changed === 1
            ? "Postponed 1 task."
            : `Postponed ${changed} tasks.`;
      const rest =
        changed === 0 || unchanged === 0
          ? ""
          : unchanged === 1
            ? " 1 is finished."
            : ` ${unchanged} are finished.`;
      const extra =
        changed === 0 || openChildren === 0
          ? ""
          : changed === 1
            ? openChildren === 1
              ? " Its open subtask moved too."
              : " Its open subtasks moved too."
            : " Their open subtasks moved too.";
      if (changed === 0) {
        toast.push(`${main}${rest}${extra}`);
        focusPostpone();
        return;
      }
      const previousByDue = new Map<string, string[]>();
      for (const task of changedTasks) {
        const before = roots.find((row) => row.id === task.id);
        if (!before) continue;
        const key = `${before.dueAt ?? ""}|${before.dueHasTime ? 1 : 0}`;
        const group = previousByDue.get(key) ?? [];
        group.push(task.id);
        previousByDue.set(key, group);
      }
      toast.push(`${main}${rest}${extra}`, {
        label: "Undo",
        run: () => {
          if (!navigator.onLine) {
            toast.push("You are offline. Reconnect to restore the previous due dates.");
            focusPostpone();
            return;
          }
          void (async () => {
            try {
              let brought = 0;
              for (const [key, undoIds] of previousByDue) {
                const [previousDue, previousHasTime] = key.split("|");
                const due = previousDue === "" ? null : previousDue;
                const hasTime = previousHasTime === "1";
                const restored = await api.batchTasks({
                  ids: undoIds,
                  action: "due",
                  dueAt: due,
                  dueHasTime: hasTime,
                });
                brought += restored.tasks.filter(
                  (task) => (task.dueAt ?? null) === due && Boolean(task.dueHasTime) === Boolean(due && hasTime),
                ).length;
              }
              const undoMain =
                brought === 0
                  ? "Those tasks already have that date."
                  : brought === 1
                    ? "Restored the date on 1 task."
                    : `Restored the date on ${brought} tasks.`;
              toast.push(undoMain);
              focusPostpone();
              await queryClient.invalidateQueries({ queryKey: ["tasks"] });
            } catch (error: unknown) {
              void queryClient.invalidateQueries({ queryKey: ["tasks"] });
              toast.push(error instanceof ApiError ? error.message : "Could not postpone the selection.");
              focusPostpone();
            }
          })();
        },
      });
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not postpone the selection.");
      focusPostpone();
    }
  }

  async function batch(action: "complete" | "delete" | "reopen") {
    const focusBatch = () =>
      focusSelectionControl(
        action === "delete" ? "delete-selected" : action === "reopen" ? "reopen-selected" : "complete-selected",
      );
    if (!online) {
      toast.push(
        action === "delete"
          ? "You are offline. Reconnect to delete the selection."
          : action === "reopen"
            ? "You are offline. Reconnect to reopen the selection."
            : "You are offline. Reconnect to complete the selection.",
      );
      focusBatch();
      return;
    }
    const ids = chosenIds();
    try {
      const result = await api.batchTasks({ ids, action });
      clearListSelection();
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      const acted = result.tasks.map((task) => task.id);
      if (action === "delete") {
        const count = acted.length;
        const carried = rows.filter((task) => acted.includes(task.id)).reduce((sum, task) => sum + (task.subtaskCount ?? 0), 0);
        const extra =
          carried === 0
            ? ""
            : count === 1
              ? carried === 1
                ? " Its subtask was deleted too."
                : " Its subtasks were deleted too."
              : " Their subtasks were deleted too.";
        const restored =
          carried === 0
            ? ""
            : count === 1
              ? carried === 1
                ? " Its subtask was restored too."
                : " Its subtasks were restored too."
              : " Their subtasks were restored too.";
        toast.push(`${count === 1 ? "Deleted 1 task." : `Deleted ${count} tasks.`}${extra}`, {
          label: "Undo",
          run: () => {
            if (!navigator.onLine) {
              toast.push("You are offline. Reconnect to restore those tasks.");
              focusBatch();
              return;
            }
            void api
              .restoreSelected(acted)
              .then((result) => {
                const main =
                  result.restored === 1 ? "Restored 1 task." : `Restored ${result.restored} tasks.`;
                const skipped =
                  result.skipped === 1
                    ? " 1 was already open."
                    : result.skipped > 1
                      ? ` ${result.skipped} were already open.`
                      : "";
                toast.push(`${main}${restored}${skipped}`);
                focusBatch();
                return queryClient.invalidateQueries({ queryKey: ["tasks"] });
              })
              .catch((error: unknown) => {
                void queryClient.invalidateQueries({ queryKey: ["tasks"] });
                toast.push(error instanceof ApiError ? error.message : "Could not restore the tasks.");
                focusBatch();
              });
          },
        });
      }
      if (action === "complete") {
        const archived = result.tasks.filter((task) => rows.find((row) => row.id === task.id)?.status === "archived").length;
        const changedTasks = result.tasks.filter((task) => {
          const before = rows.find((row) => row.id === task.id);
          if (!before) return true;
          if (before.status === "archived") return false;
          if (before.recurrence) return true;
          return before.status !== "completed";
        });
        const changed = changedTasks.length;
        const unchanged = result.tasks.length - changed - archived;
        const openChildren = rows
          .filter((task) => changedTasks.some((item) => item.id === task.id) && !task.recurrence)
          .reduce((sum, task) => sum + (task.openSubtaskCount ?? 0), 0);
        const main =
          changed === 0
            ? archived > 0 && unchanged === 0
              ? archived === 1
                ? "That task is archived."
                : "Those tasks are archived."
              : unchanged === 1
                ? "That task is already completed."
                : "Those tasks are already completed."
            : changed === 1
              ? "Completed 1 task."
              : `Completed ${changed} tasks.`;
        const rest =
          changed === 0 || unchanged === 0
            ? ""
            : unchanged === 1
              ? " 1 was already completed."
              : ` ${unchanged} were already completed.`;
        const archivedRest =
          changed === 0 || archived === 0
            ? ""
            : archived === 1
              ? " 1 is archived."
              : ` ${archived} are archived.`;
        const extra =
          changed === 0 || openChildren === 0
            ? ""
            : changed === 1
              ? openChildren === 1
                ? " Its open subtask was completed too."
                : " Its open subtasks were completed too."
              : " Their open subtasks were completed too.";
        if (changed === 0) {
          toast.push(`${main}${rest}${archivedRest}${extra}`);
          focusBatch();
          return;
        }
        const undoIds = changedTasks.map((task) => task.id);
        toast.push(`${main}${rest}${archivedRest}${extra}`, {
          label: "Undo",
          run: () => {
            if (!navigator.onLine) {
              toast.push("You are offline. Reconnect to reopen the selection.");
              focusBatch();
              return;
            }
            void (async () => {
              try {
                let brought = 0;
                for (const id of undoIds) {
                  const restored = await api.uncompleteTask(id);
                  if (restored.status === "open" || restored.recurrence) brought += 1;
                }
                const undoMain =
                  brought === 0
                    ? "Those tasks are already open."
                    : brought === 1
                      ? "Reopened 1 task."
                      : `Reopened ${brought} tasks.`;
                toast.push(undoMain);
                focusBatch();
                await queryClient.invalidateQueries({ queryKey: ["tasks"] });
              } catch (error: unknown) {
                void queryClient.invalidateQueries({ queryKey: ["tasks"] });
                toast.push(error instanceof ApiError ? error.message : "Could not reopen the selection.");
                focusBatch();
              }
            })();
          },
        });
      }
      if (action === "reopen") {
        const selected = new Set(ids);
        const roots = rows.filter((task) => ids.includes(task.id) && (!task.parentId || !selected.has(task.parentId)));
        const changedRoots = roots.filter((task) => task.status === "completed");
        const changed = changedRoots.length;
        const unchanged = roots.length - changed;
        const carried = rows.filter((task) => changedRoots.some((item) => item.id === task.parentId) && task.status === "completed" && !task.recurrence).length;
        const parentsBack = new Set(
          result.tasks.flatMap((task) =>
            task.parentId &&
            changedRoots.some((item) => item.id === task.id) &&
            !changedRoots.some((item) => item.id === task.parentId) &&
            rows.some((row) => row.id === task.parentId && row.status === "completed")
              ? [task.parentId]
              : [],
          ),
        ).size;
        const main =
          changed === 0
            ? unchanged === 1
              ? "That task is already open."
              : "Those tasks are already open."
            : changed === 1
              ? "Reopened 1 task."
              : `Reopened ${changed} tasks.`;
        const rest =
          changed === 0 || unchanged === 0
            ? ""
            : unchanged === 1
              ? " 1 was already open."
              : ` ${unchanged} were already open.`;
        const extra =
          changed === 0
            ? ""
            : carried > 0
              ? changed === 1
                ? carried === 1
                  ? " Its subtask was reopened too."
                  : " Its subtasks were reopened too."
                : " Their subtasks were reopened too."
              : parentsBack === 0
                ? ""
                : parentsBack === 1
                  ? changed === 1
                    ? " Its task was reopened too."
                    : " Their task was reopened too."
                  : " Their tasks were reopened too.";
        if (changed === 0) {
          toast.push(`${main}${rest}${extra}`);
          focusBatch();
          return;
        }
        const undoIds = changedRoots.map((task) => task.id);
        toast.push(`${main}${rest}${extra}`, {
          label: "Undo",
          run: () => {
            if (!navigator.onLine) {
              toast.push("You are offline. Reconnect to complete the selection.");
              focusBatch();
              return;
            }
            void api
              .batchTasks({ ids: undoIds, action: "complete" })
              .then((restored) => {
                const brought = restored.tasks.filter((task) => {
                  const before = changedRoots.find((row) => row.id === task.id);
                  if (!before) return false;
                  if (before.recurrence) return true;
                  return task.status === "completed";
                }).length;
                const undoMain =
                  brought === 0
                    ? "Those tasks are already completed."
                    : brought === 1
                      ? "Completed 1 task."
                      : `Completed ${brought} tasks.`;
                toast.push(undoMain);
                focusBatch();
                return queryClient.invalidateQueries({ queryKey: ["tasks"] });
              })
              .catch((error: unknown) => {
                void queryClient.invalidateQueries({ queryKey: ["tasks"] });
                toast.push(error instanceof ApiError ? error.message : "Could not complete the selection.");
                focusBatch();
              });
          },
        });
      }
    } catch (error) {
      toast.push(
        error instanceof ApiError
          ? error.message
          : action === "delete"
            ? "Could not delete the selection."
            : action === "reopen"
              ? "Could not reopen the selection."
              : "Could not complete the selection.",
      );
      focusBatch();
    }
  }

  return (
    <div className="flex min-h-full">
      <section className="min-w-0 flex-1 px-4 py-5 md:px-8">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 id="workspace-heading" className="font-serif text-4xl" tabIndex={-1}>
              {heading}
            </h1>
            <p className="mt-1 text-sm text-muted">
              {view.kind === "list" && lists.isError
                ? "This list name could not be loaded."
                : view.kind === "tag" && tags.isError
                  ? "This tag name could not be loaded."
                  : copyFor(view)}
              {overdueCount > 0 ? ` ${overdueCount === 1 ? "1 task is overdue." : `${overdueCount} tasks are overdue.`}` : ""}
            </p>
            {lists.isError ? (
              <div className="mt-2 text-sm">
                <p>Lists could not be loaded.</p>
                <button className="mt-1 text-accent" type="button" aria-label="Lists could not be loaded. Try again" onClick={() => void lists.refetch()}>
                  Try again
                </button>
              </div>
            ) : null}
            {tags.isError ? (
              <div className="mt-2 text-sm">
                <p>Tags could not be loaded.</p>
                <button className="mt-1 text-accent" type="button" aria-label="Tags could not be loaded. Try again" onClick={() => void tags.refetch()}>
                  Try again
                </button>
              </div>
            ) : null}
          </div>
          {view.kind === "calendar" ? null : (
            <div className="flex gap-3">
              {view.kind === "completed" && rows.length > 0 ? (
                <button
                  id="clear-completed"
                  className="text-sm text-accent disabled:opacity-50"
                  type="button"
                  aria-label="Clear completed"
                  disabled={!online}
                  onClick={() => void clearCompleted()}
                >
                  Clear completed
                </button>
              ) : null}
              {selecting && rows.length > 0 ? (
                <button
                  className="text-sm text-accent"
                  type="button"
                  aria-label="Select all in list"
                  onClick={() => setChecked(rows.map((task) => task.id))}
                >
                  Select all
                </button>
              ) : null}
              {selecting && checked.length > 0 ? (
                <button className="text-sm text-accent" type="button" aria-label="Clear list selection" onClick={clearListSelection}>
                  Clear selection
                </button>
              ) : null}
              <button
                ref={selectToggleRef}
                className="text-sm text-accent"
                type="button"
                aria-label={selecting ? "Done selecting in list" : "Select in list"}
                aria-pressed={selecting}
                onClick={() => {
                  setSelecting((value) => {
                    if (value) setChecked([]);
                    return !value;
                  });
                }}
              >
                {selecting ? "Done selecting" : "Select"}
              </button>
            </div>
          )}
        </div>
        {view.kind !== "completed" && view.kind !== "calendar" ? (
          <form
            className="mb-4 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void addTask();
            }}
          >
            <Input
              id="quick-add"
              aria-label="Quick add task"
              placeholder="Add a task and press Enter"
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
            />
            <Button type="submit">Add</Button>
          </form>
        ) : null}
        {view.kind !== "calendar" ? (
          <div className="mb-3 flex flex-wrap gap-2 text-sm">
            {(["", "high", "medium", "low", "none"] as const).map((item) => (
              <button
                key={item || "any"}
                type="button"
                aria-pressed={priority === item}
                className={`rounded-full px-3 py-1 ${priority === item ? "bg-accent text-accent-ink" : "bg-sidebar"}`}
                onClick={() => setPriority(item)}
              >
                {item === "" ? "Any priority" : item}
              </button>
            ))}
            {view.kind !== "today" && view.kind !== "upcoming" ? (
              <button
                ref={filterAnchorRef}
                type="button"
                aria-pressed={undated}
                aria-label="No date in list"
                className={`rounded-full px-3 py-1 ${undated ? "bg-accent text-accent-ink" : "bg-sidebar"}`}
                onClick={() => {
                  setUndated((value) => !value);
                  setOverdueOnly(false);
                }}
              >
                No date
              </button>
            ) : (
              <button
                ref={filterAnchorRef}
                type="button"
                aria-pressed={waiting}
                className={`rounded-full px-3 py-1 ${waiting ? "bg-accent text-accent-ink" : "bg-sidebar"}`}
                onClick={() => setWaiting((value) => !value)}
              >
                Not started
              </button>
            )}
            {view.kind !== "upcoming" && view.kind !== "completed" ? (
              <button
                type="button"
                aria-pressed={overdueOnly}
                className={`rounded-full px-3 py-1 ${overdueOnly ? "bg-accent text-accent-ink" : "bg-sidebar"}`}
                onClick={() => {
                  setOverdueOnly((value) => !value);
                  setUndated(false);
                }}
              >
                Overdue
              </button>
            ) : null}
            <button
              type="button"
              aria-pressed={pinnedOnly}
              className={`rounded-full px-3 py-1 ${pinnedOnly ? "bg-accent text-accent-ink" : "bg-sidebar"}`}
              onClick={() => setPinnedOnly((value) => !value)}
            >
              Pinned
            </button>
            <button
              type="button"
              aria-pressed={mine}
              className={`rounded-full px-3 py-1 ${mine ? "bg-accent text-accent-ink" : "bg-sidebar"}`}
              onClick={() => setMine((value) => !value)}
            >
              Assigned to me
            </button>
            {filtered ? (
              <button type="button" className="rounded-full px-3 py-1 text-accent" aria-label="Clear list filters" onClick={clearFilters}>
                Clear filters
              </button>
            ) : null}
            {canSort
              ? (["due", "priority", "title"] as const).map((item) => (
                  <button
                    key={item}
                    id={`sort-by-${item}`}
                    type="button"
                    className="rounded-full bg-sidebar px-3 py-1 disabled:opacity-50"
                    aria-label={item === "due" ? "Sort by due date" : `Sort by ${item}`}
                    disabled={!online}
                    onClick={() => void sortTasks(item)}
                  >
                    Sort by {item}
                  </button>
                ))
              : null}
          </div>
        ) : null}
        {selecting && chosenIds().length > 0 ? (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted">{chosenIds().length === 1 ? "1 selected" : `${chosenIds().length} selected`}</span>
            {!online ? (
                  <span className="text-sm text-muted">You are offline. Reconnect to use selection actions.</span>
                ) : null}
            {view.kind === "completed" ? (
              <Button
                id="reopen-selected"
                type="button"
                size="sm"
                variant="secondary"
                aria-label="Reopen selected"
                disabled={!online}
                onClick={() => void batch("reopen")}
              >
                Reopen selected
              </Button>
            ) : (
              <Button
                id="complete-selected"
                type="button"
                size="sm"
                aria-label="Complete selected"
                disabled={!online}
                onClick={() => void batch("complete")}
              >
                Complete selected
              </Button>
            )}
            {view.kind !== "completed" ? (
              <Button
                id="postpone-selected"
                type="button"
                size="sm"
                variant="secondary"
                aria-label="Postpone selected"
                disabled={!online}
                onClick={() => void postponeSelected()}
              >
                Postpone selected
              </Button>
            ) : null}
            {view.kind !== "completed" ? (
              <Button
                id="skip-selected"
                type="button"
                size="sm"
                variant="secondary"
                aria-label="Skip selected"
                disabled={!online}
                onClick={() => void skipSelected()}
              >
                Skip selected
              </Button>
            ) : null}
            {view.kind !== "completed" ? (
              <Button
                id="omit-selected"
                type="button"
                size="sm"
                variant="secondary"
                disabled={!online}
                aria-label="Remove this date from selected"
                onClick={() => void omitSelected()}
              >
                Remove this date
              </Button>
            ) : null}
            <Button
              id="delete-selected"
              type="button"
              size="sm"
              variant="danger"
              aria-label="Delete selected"
              disabled={!online}
              onClick={() => void batch("delete")}
            >
              Delete selected
            </Button>
            <Button
              id="duplicate-selected"
              type="button"
              size="sm"
              variant="secondary"
              aria-label="Duplicate selected"
              disabled={!online}
              onClick={() => void duplicateSelected()}
            >
              Duplicate selected
            </Button>
            <Button
              id="archive-selected"
              type="button"
              size="sm"
              variant="secondary"
              aria-label="Archive selected"
              disabled={!online}
              onClick={() => void archiveSelected()}
            >
              Archive selected
            </Button>
            <label className="text-sm">
              <span className="sr-only">Move selected tasks to</span>
              <select
                aria-label="Move selected tasks to"
                className="h-8 rounded-lg border border-line bg-surface px-2"
                value={moveTo}
                onChange={(event) => setMoveTo(event.target.value)}
                disabled={!online || lists.isError || lists.isLoading}
              >
                <option value="">Move to…</option>
                {(lists.data ?? [])
                  .filter((list) => !list.archivedAt)
                  .map((list) => (
                    <option key={list.id} value={list.id}>
                      {list.name}
                    </option>
                  ))}
              </select>
            </label>
            {lists.isError ? (
              <button className="text-sm text-accent" type="button" aria-label="Retry lists for selected tasks" onClick={() => void lists.refetch()}>
                Retry lists
              </button>
            ) : lists.isLoading ? (
              <span className="text-sm text-muted" role="status">
                Loading lists…
              </span>
            ) : null}
            <Button
              id="move-selected"
              type="button"
              size="sm"
              variant="secondary"
              disabled={!online || !moveTo || lists.isError || lists.isLoading}
              aria-label="Move selected"
              onClick={() => void moveSelected()}
            >
              Move
            </Button>
            <label className="text-sm">
              <span className="sr-only">Parent for selected tasks</span>
              <select
                aria-label="Parent for selected tasks"
                className="h-8 rounded-lg border border-line bg-surface px-2"
                value={parentTo}
                onChange={(event) => setParentTo(event.target.value)}
                disabled={!online || tasks.isError || tasks.isLoading}
              >
                <option value="">Under…</option>
                <option value="none">Own task</option>
                {rows
                  .filter((task) => task.status === "open" && !task.parentId && !chosenIds().includes(task.id))
                  .map((task) => (
                    <option key={task.id} value={task.id}>
                      {task.title}
                    </option>
                  ))}
              </select>
            </label>
            {tasks.isError ? (
              <button className="text-sm text-accent" type="button" aria-label="Retry parents for selected tasks" onClick={() => void tasks.refetch()}>
                Retry parents
              </button>
            ) : tasks.isLoading ? (
              <span className="text-sm text-muted" role="status">
                Loading parents…
              </span>
            ) : null}
            <Button
              id="parent-selected"
              type="button"
              size="sm"
              variant="secondary"
              disabled={!online || !parentTo || tasks.isError || tasks.isLoading}
              aria-label="Set parent for selected"
              onClick={() => void parentSelected()}
            >
              Set parent
            </Button>
            {view.kind !== "completed" ? (
              <>
            <label className="text-sm">
              <span className="sr-only">Set priority of selected tasks</span>
              <select
                aria-label="Set priority of selected tasks"
                className="h-8 rounded-lg border border-line bg-surface px-2"
                value={priorityTo}
                onChange={(event) => setPriorityTo(event.target.value as Priority | "")}
                disabled={!online}
              >
                <option value="">Priority…</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
                <option value="none">None</option>
              </select>
            </label>
            <Button
              id="priority-selected"
              type="button"
              size="sm"
              variant="secondary"
              disabled={!online || !priorityTo}
              aria-label="Set priority for selected"
              onClick={() => void setSelectedPriority()}
            >
              Set priority
            </Button>
            <label className="text-sm">
              <span className="sr-only">Due date for selected tasks</span>
              <input
                id="due-selected"
                type="date"
                aria-label="Due date for selected tasks"
                className="h-8 rounded-lg border border-line bg-surface px-2"
                value={dueOn}
                onChange={(event) => setDueOn(event.target.value)}
                disabled={!online}
              />
            </label>
            <label className="text-sm">
              <span className="sr-only">Due time for selected tasks</span>
              <input
                type="time"
                aria-label="Due time for selected tasks"
                className="h-8 rounded-lg border border-line bg-surface px-2"
                value={dueAtTime}
                onChange={(event) => setDueAtTime(event.target.value)}
                disabled={!online}
              />
            </label>
            <Button type="button" size="sm" variant="secondary" disabled={!online || !dueOn} aria-label="Set date for selected" onClick={applySelectedDate}>
              Set date
            </Button>
            <Button type="button" size="sm" variant="secondary" disabled={!online} aria-label="Clear date for selected" onClick={() => void setSelectedDue(null, false)}>
              Clear date
            </Button>
            <label className="text-sm">
              <span className="sr-only">Start date for selected tasks</span>
              <input
                id="start-selected"
                type="date"
                aria-label="Start date for selected tasks"
                className="h-8 rounded-lg border border-line bg-surface px-2"
                value={startOn}
                onChange={(event) => setStartOn(event.target.value)}
                disabled={!online}
              />
            </label>
            <Button type="button" size="sm" variant="secondary" disabled={!online || !startOn} aria-label="Set start for selected" onClick={applySelectedStart}>
              Set start
            </Button>
            <Button type="button" size="sm" variant="secondary" disabled={!online} aria-label="Clear start for selected" onClick={() => void setSelectedStart(null)}>
              Clear start
            </Button>
            <label className="text-sm">
              <span className="sr-only">Estimate for selected tasks</span>
              <input
                id="estimate-selected"
                type="number"
                min={0}
                max={100000}
                step={1}
                aria-label="Estimate for selected tasks"
                className="h-8 w-28 rounded-lg border border-line bg-surface px-2"
                placeholder="Minutes"
                value={estimateTo}
                onChange={(event) => setEstimateTo(event.target.value)}
                disabled={!online}
              />
            </label>
            <Button type="button" size="sm" variant="secondary" disabled={!online || estimateTo.trim() === ""} aria-label="Set estimate for selected" onClick={applySelectedEstimate}>
              Set estimate
            </Button>
            <Button type="button" size="sm" variant="secondary" disabled={!online} aria-label="Clear estimate for selected" onClick={() => void setSelectedEstimate(null)}>
              Clear estimate
            </Button>
            <label className="text-sm">
              <span className="sr-only">Reminder for selected tasks</span>
              <select
                id="reminder-selected"
                aria-label="Reminder for selected tasks"
                className="h-8 rounded-lg border border-line bg-surface px-2"
                value={reminderTo}
                onChange={(event) => setReminderTo(event.target.value)}
                disabled={!online}
              >
                <option value="">Reminder…</option>
                <option value="0">At the due time</option>
                <option value="15">15 minutes before</option>
                <option value="60">1 hour before</option>
                <option value="1440">1 day before</option>
              </select>
            </label>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={!online || reminderTo === ""}
              aria-label="Set reminder for selected"
              onClick={() => void setSelectedReminder(Number(reminderTo))}
            >
              Set reminder
            </Button>
            <Button type="button" size="sm" variant="secondary" disabled={!online} aria-label="Clear reminder for selected" onClick={() => void setSelectedReminder(null)}>
              Clear reminder
            </Button>
            <Button
              id="pin-selected"
              type="button"
              size="sm"
              variant="secondary"
              disabled={!online}
              aria-label="Pin selected"
              onClick={() => void pinSelected(true)}
            >
              Pin selected
            </Button>
            <Button
              id="unpin-selected"
              type="button"
              size="sm"
              variant="secondary"
              disabled={!online}
              aria-label="Unpin selected"
              onClick={() => void pinSelected(false)}
            >
              Unpin selected
            </Button>
            <label className="text-sm">
              <span className="sr-only">Assign selected tasks</span>
              <select
                aria-label="Assign selected tasks"
                className="h-8 rounded-lg border border-line bg-surface px-2"
                value={assignTo}
                onChange={(event) => setAssignTo(event.target.value)}
                disabled={!online || members.isError || members.isLoading}
              >
                <option value="">Assign to…</option>
                <option value="none">Nobody</option>
                {(members.data ?? []).map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.email}
                  </option>
                ))}
              </select>
            </label>
            {members.isError ? (
              <button className="text-sm text-accent" type="button" aria-label="Retry assignees for selected tasks" onClick={() => void members.refetch()}>
                Retry assignees
              </button>
            ) : members.isLoading ? (
              <span className="text-sm text-muted" role="status">
                Loading people…
              </span>
            ) : null}
            <Button
              id="assign-selected"
              type="button"
              size="sm"
              variant="secondary"
              disabled={!online || assignTo === "" || members.isError || members.isLoading}
              aria-label="Assign selected"
              onClick={() => void assignSelected()}
            >
              Assign
            </Button>
            <label className="text-sm">
              <span className="sr-only">Repeat rule for selected tasks</span>
              <select
                aria-label="Repeat rule for selected tasks"
                className="h-8 rounded-lg border border-line bg-surface px-2"
                value={repeatTo}
                onChange={(event) => setRepeatTo(event.target.value)}
                disabled={!online}
              >
                <option value="">Repeat…</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="yearly">Yearly</option>
                <option value="none">Does not repeat</option>
              </select>
            </label>
            {repeatTo !== "" && repeatTo !== "none" ? (
              <label className="text-sm">
                <span className="sr-only">Repeat interval for selected tasks</span>
                <input
                  id="repeat-every-selected"
                  type="number"
                  min={1}
                  max={99}
                  step={1}
                  aria-label="Repeat interval for selected tasks"
                  className="h-8 w-16 rounded-lg border border-line bg-surface px-2"
                  value={repeatEvery}
                  onChange={(event) => setRepeatEvery(event.target.value)}
                  disabled={!online}
                />
              </label>
            ) : null}
            {repeatTo !== "" && repeatTo !== "none" ? (
              <label className="text-sm">
                <span className="sr-only">Repeat count for selected tasks</span>
                <input
                  id="repeat-count-selected"
                  type="number"
                  min={1}
                  max={999}
                  step={1}
                  aria-label="Repeat count for selected tasks"
                  className="h-8 w-20 rounded-lg border border-line bg-surface px-2"
                  placeholder="Times"
                  value={repeatCount}
                  onChange={(event) => setRepeatCount(event.target.value)}
                  disabled={!online}
                />
              </label>
            ) : null}
            {repeatTo !== "" && repeatTo !== "none" ? (
              <label className="text-sm">
                <span className="sr-only">Repeat end date for selected tasks</span>
                <input
                  id="repeat-until-selected"
                  type="date"
                  aria-label="Repeat end date for selected tasks"
                  className="h-8 rounded-lg border border-line bg-surface px-2"
                  value={repeatUntil}
                  onChange={(event) => setRepeatUntil(event.target.value)}
                  disabled={!online}
                />
              </label>
            ) : null}
            {repeatTo === "weekly" ? (
              <div className="flex flex-wrap gap-2 text-sm">
                {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((label, index) => {
                  const day = index + 1;
                  return (
                    <label key={label} className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        aria-label={label}
                        checked={weekdays.includes(day)}
                        disabled={!online}
                        onChange={() => setWeekdays((current) => (current.includes(day) ? current.filter((item) => item !== day) : [...current, day]))}
                      />
                      {label}
                    </label>
                  );
                })}
              </div>
            ) : null}
            <Button
              id="repeat-selected"
              type="button"
              size="sm"
              variant="secondary"
              disabled={!online || repeatTo === ""}
              aria-label="Set repeat for selected"
              onClick={() => void repeatSelected()}
            >
              Set repeat
            </Button>
              </>
            ) : null}
            <label className="text-sm">
              <span className="sr-only">Tag for selected tasks</span>
              <select
                aria-label="Tag for selected tasks"
                className="h-8 rounded-lg border border-line bg-surface px-2"
                value={tagTo}
                onChange={(event) => setTagTo(event.target.value)}
                disabled={!online || tags.isError || tags.isLoading}
              >
                <option value="">Tag…</option>
                {(tags.data ?? []).map((tag) => (
                  <option key={tag.id} value={tag.id}>
                    {tag.name}
                  </option>
                ))}
              </select>
            </label>
            {tags.isError ? (
              <button className="text-sm text-accent" type="button" aria-label="Retry tags for selected tasks" onClick={() => void tags.refetch()}>
                Retry tags
              </button>
            ) : tags.isLoading ? (
              <span className="text-sm text-muted" role="status">
                Loading tags…
              </span>
            ) : null}
            <Button
              id="add-tag-selected"
              type="button"
              size="sm"
              variant="secondary"
              disabled={!online || !tagTo || tags.isError || tags.isLoading}
              aria-label="Add tag to selected"
              onClick={() => void setSelectedTag("add")}
            >
              Add tag
            </Button>
            <Button
              id="remove-tag-selected"
              type="button"
              size="sm"
              variant="secondary"
              disabled={!online || !tagTo || tags.isError || tags.isLoading}
              aria-label="Remove tag from selected"
              onClick={() => void setSelectedTag("remove")}
            >
              Remove tag
            </Button>
          </div>
        ) : null}
        {view.kind === "calendar" && me.data ? <CalendarBoard timeZone={me.data.timeZone} onOpen={openTask} /> : null}
        {view.kind !== "calendar" && tasks.isLoading ? (
          <div className="space-y-2">
            <p className="text-sm text-muted" role="status">
              Loading tasks…
            </p>
            <div className="space-y-2" aria-hidden="true">
              {Array.from({ length: 6 }, (_, index) => (
                <div key={index} className="h-14 animate-pulse rounded-lg bg-sidebar" />
              ))}
            </div>
          </div>
        ) : null}
        {view.kind !== "calendar" && tasks.isError ? (
          <div className="rounded-lg border border-line bg-surface p-4 text-sm">
            <p>The task list could not be loaded.</p>
            <button
              className="mt-2 text-accent"
              type="button"
              aria-label="The task list could not be loaded. Try again"
              onClick={() => {
                void tasks.refetch();
              }}
            >
              Try again
            </button>
          </div>
        ) : null}
        {view.kind !== "calendar" && tasks.data && rows.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-line bg-surface px-4 py-14 text-center shadow-sm" role="status">
            {filtered ? (
              <>
                <p className="font-medium">No tasks match these filters</p>
                <p className="mt-1 text-sm text-muted">Clear filters to see the full list again.</p>
                <button className="mt-3 text-sm text-accent" type="button" aria-label="Clear list filters" onClick={clearFilters}>
                  Clear filters
                </button>
              </>
            ) : view.kind === "search" ? (
              <>
                <p className="font-medium">{view.query ? "No matching tasks" : "Nothing to search yet"}</p>
                <p className="mt-1 text-sm text-muted">
                  {view.query ? "Try another word, or clear the search field above." : "Use the search field above to find tasks by title, description, or tag."}
                </p>
              </>
            ) : view.kind === "completed" ? (
              <>
                <p className="font-medium">No finished tasks</p>
                <p className="mt-1 text-sm text-muted">Completed tasks show up here when you finish them.</p>
              </>
            ) : view.kind === "today" ? (
              <>
                <p className="font-medium">Nothing due today</p>
                <p className="mt-1 text-sm text-muted">Open tasks due today, and anything overdue, show up here.</p>
              </>
            ) : view.kind === "upcoming" ? (
              <>
                <p className="font-medium">Nothing upcoming</p>
                <p className="mt-1 text-sm text-muted">Open tasks due after today show up here.</p>
              </>
            ) : view.kind === "inbox" ? (
              <>
                <p className="font-medium">Inbox is empty</p>
                <p className="mt-1 text-sm text-muted">Add a task when you are ready. This view updates from your account.</p>
              </>
            ) : view.kind === "all" ? (
              <>
                <p className="font-medium">No open tasks</p>
                <p className="mt-1 text-sm text-muted">Open tasks from every list show up here.</p>
              </>
            ) : view.kind === "list" ? (
              <>
                <p className="font-medium">This list is empty</p>
                <p className="mt-1 text-sm text-muted">Add a task when you are ready. This view updates from your account.</p>
              </>
            ) : view.kind === "tag" ? (
              <>
                <p className="font-medium">No open tasks with this tag</p>
                <p className="mt-1 text-sm text-muted">Tag a task to see it here.</p>
              </>
            ) : (
              <>
                <p className="font-medium">Nothing here yet</p>
                <p className="mt-1 text-sm text-muted">Add a task when you are ready. This view updates from your account.</p>
              </>
            )}
          </div>
        ) : null}
        {view.kind !== "calendar" && rows.length > 0 ? (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(event) => void onDragEnd(event)}>
            <SortableContext items={rows.map((task) => task.id)} strategy={verticalListSortingStrategy}>
              <div className="overflow-hidden rounded-3xl border border-line bg-surface shadow-sm">
                {rows.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    timeZone={me.data?.timeZone ?? "UTC"}
                    selected={selectedId === task.id}
                    selecting={selecting}
                    checked={checked.includes(task.id)}
                    sortable={sortable}
                    onOpen={openTask}
                    onToggleSelect={(id) => setChecked((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))}
                    listName={
                      view.kind === "list" || view.kind === "inbox"
                        ? undefined
                        : (lists.data ?? []).find((list) => list.id === task.listId)?.name
                    }
                    tags={tags.data ?? []}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        ) : null}
        {tasks.data?.truncated ? <p className="mt-3 text-sm text-muted">Showing the first 500 tasks.</p> : null}
        {tasks.data?.occurrences && tasks.data.occurrences.length > 0 ? (
          <div className="mt-6">
            <h2 className="text-sm font-medium uppercase tracking-wide text-muted">Repeat history</h2>
            <ul className="mt-2 divide-y divide-line rounded-xl border border-line bg-surface">
              {tasks.data.occurrences.map((item) => (
                <li key={item.id} className="px-3 py-2 text-sm">
                  {item.title} · {item.action} · {new Date(item.occurrenceDueAt).toLocaleString()}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
      {selectedId ? (
        <aside
          className="fixed inset-0 z-40 bg-surface lg:static lg:z-auto lg:block lg:w-[380px] lg:border-l lg:border-line"
          role="dialog"
          aria-modal="true"
          aria-labelledby="task-detail-title"
        >
          <TaskDetail
            taskId={selectedId}
            lists={lists.data ?? []}
            tags={tags.data ?? []}
            listsFailed={lists.isError}
            listsLoading={lists.isLoading}
            tagsFailed={tags.isError}
            tagsLoading={tags.isLoading}
            onRetryLists={() => void lists.refetch()}
            onRetryTags={() => void tags.refetch()}
            onClose={closeTask}
            onOpen={openTask}
          />
        </aside>
      ) : null}
    </div>
  );
}

function headingFor(
  view: WorkspaceView,
  lists: { id: string; name: string }[],
  tags: { id: string; name: string }[],
  listsFailed = false,
  tagsFailed = false,
): string {
  if (view.kind === "list") {
    const name = lists.find((list) => list.id === view.listId)?.name;
    if (name) return name;
    return listsFailed ? "List unavailable" : "List";
  }
  if (view.kind === "tag") {
    const name = tags.find((tag) => tag.id === view.tagId)?.name;
    if (name) return name;
    return tagsFailed ? "Tag unavailable" : "Tag";
  }
  if (view.kind === "search") return view.query ? `Search “${view.query}”` : "Search";
  return titles[view.kind] ?? "Tasks";
}

function copyFor(view: WorkspaceView): string {
  if (view.kind === "today") return "Open tasks due today, plus anything overdue. A future start date stays off this list until that date.";
  if (view.kind === "inbox" || view.kind === "list") return "Drag a row to reorder, or sort by due date, priority, or title. Pinned tasks stay at the top. A filter turns dragging off so hidden tasks keep their order.";
  if (view.kind === "upcoming") return "Open tasks due after today. A future start date stays off this list until that date.";
  if (view.kind === "completed") return "Finished tasks and the history of repeating ones. Clear completed moves yours to Trash. Undo puts them back. Reopen puts a finished task back.";
  if (view.kind === "calendar") return "Month, week, and day in your time zone. A busy month day can open that day. A finished task is crossed out.";
  if (view.kind === "search") return view.query ? "Matches in titles, descriptions, and your tag names. Finished tasks are included." : "Use the search field above.";
  return "Drag a row to reorder. A filter turns dragging off so hidden tasks keep their order. Press C to add a task.";
}

function isTextEntry(target: HTMLElement | null): target is HTMLElement {
  if (!target) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === "TEXTAREA") return true;
  if (target.tagName !== "INPUT") return false;
  const type = (target as HTMLInputElement).type;
  return type !== "checkbox" && type !== "radio" && type !== "button" && type !== "submit" && type !== "reset";
}
