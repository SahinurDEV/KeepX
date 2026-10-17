"use client";

import { ApiError } from "@vela/api-client";
import type { ListDto, ListIcon } from "@vela/shared";
import { LIST_COLORS, LIST_ICONS } from "@vela/shared";
import { Button, Dialog, Input } from "@vela/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Book,
  Briefcase,
  Calendar,
  CalendarClock,
  CheckCheck,
  Code,
  Flag,
  CircleHelp,
  Gift,
  Heart,
  Home,
  Inbox,
  ListTodo,
  Menu,
  Moon,
  Music,
  Plane,
  Search,
  Settings,
  Star,
  Sun,
  Tags,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Mark } from "@/components/site-frame";
import { useOnline, useToast } from "@/components/providers";
import { useSync } from "@/components/sync-provider";
import { api, appName } from "@/lib/api";

const nav = [
  { href: "/today", label: "Today", icon: Sun },
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/upcoming", label: "Upcoming", icon: CalendarClock },
  { href: "/tasks", label: "All tasks", icon: ListTodo },
  { href: "/completed", label: "Completed", icon: CheckCheck },
  { href: "/trash", label: "Trash", icon: Trash2 },
  { href: "/calendar", label: "Calendar", icon: Calendar },
  { href: "/tags", label: "Tags", icon: Tags },
];

function canFocusShellControl(element: HTMLElement | null): element is HTMLElement {
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
  if (element.getAttribute("aria-disabled") === "true") return false;
  return true;
}

function focusShellTargets(resolve: () => Array<HTMLElement | null>) {
  queueMicrotask(() => {
    for (const target of resolve()) {
      if (!canFocusShellControl(target)) continue;
      target.focus();
      return;
    }
    document.getElementById("content")?.focus();
  });
}

function focusShellControl(...ids: string[]) {
  focusShellTargets(() => ids.map((id) => document.getElementById(id)));
}

function focusShellQuery(...selectors: string[]) {
  focusShellTargets(() => selectors.map((selector) => document.querySelector<HTMLElement>(selector)));
}

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const online = useOnline();
  const toast = useToast();
  const sync = useSync();
  const queryClient = useQueryClient();
  const [collapsed, setCollapsed] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [listDraft, setListDraft] = useState<ListDto | null>(null);
  const [shareList, setShareList] = useState<ListDto | null>(null);
  const [listToDelete, setListToDelete] = useState<ListDto | null>(null);
  const noticing = useRef(new Set<string>());
  const reminderPollFailed = useRef(false);
  const [shareEmail, setShareEmail] = useState("");
  const members = useQuery({
    queryKey: ["members", shareList?.id],
    queryFn: () => api.listMembers(shareList?.id ?? ""),
    enabled: Boolean(shareList),
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const [darkAppearance, setDarkAppearance] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const accountButtonRef = useRef<HTMLButtonElement | null>(null);
  const shareOpenerRef = useRef<HTMLElement | null>(null);
  const deleteOpenerRef = useRef<HTMLElement | null>(null);
  const listOpenerRef = useRef<HTMLElement | null>(null);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.me(), retry: false });
  const lists = useQuery({ queryKey: ["lists"], queryFn: () => api.lists(), enabled: Boolean(me.data) });

  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) router.replace("/login");
  }, [me.error, router]);

  useEffect(() => {
    const stored = localStorage.getItem("vela-sidebar");
    if (stored === "collapsed") setCollapsed(true);
  }, []);

  useEffect(() => {
    setDarkAppearance(document.documentElement.classList.contains("dark"));
  }, []);

  useEffect(() => {
    return window.keepx?.onQuickAdd(() => {
      document.getElementById("quick-add")?.focus();
    });
  }, []);

  function closeAccountMenu() {
    setMenuOpen(false);
    queueMicrotask(() => accountButtonRef.current?.focus());
  }

  function openShare(list: ListDto) {
    const active = document.activeElement;
    if (active instanceof HTMLElement) shareOpenerRef.current = active;
    setShareList(list);
  }

  function closeShare() {
    setShareList(null);
    setShareEmail("");
    const opener = shareOpenerRef.current;
    shareOpenerRef.current = null;
    queueMicrotask(() => {
      if (canFocusShellControl(opener)) opener.focus();
      else focusShellControl("new-list", "appearance-toggle");
    });
  }

  function openDeleteList(list: ListDto) {
    const active = document.activeElement;
    if (active instanceof HTMLElement) deleteOpenerRef.current = active;
    setListToDelete(list);
  }

  function closeDeleteList() {
    setListToDelete(null);
    const opener = deleteOpenerRef.current;
    deleteOpenerRef.current = null;
    queueMicrotask(() => {
      if (canFocusShellControl(opener)) opener.focus();
      else focusShellControl("new-list", "appearance-toggle");
    });
  }

  function openListEditor(list: ListDto | null) {
    const active = document.activeElement;
    if (active instanceof HTMLElement) listOpenerRef.current = active;
    setListDraft(list);
    setListOpen(true);
  }

  function closeListEditor() {
    setListOpen(false);
    setListDraft(null);
    const opener = listOpenerRef.current;
    listOpenerRef.current = null;
    queueMicrotask(() => {
      if (canFocusShellControl(opener)) opener.focus();
      else focusShellControl("new-list", "appearance-toggle");
    });
  }

  function closeMoreMenu() {
    setMoreOpen(false);
    queueMicrotask(() => moreButtonRef.current?.focus());
  }

  useEffect(() => {
    if (!menuOpen) return;
    const firstItem = menuRef.current?.querySelector<HTMLElement>("[role='menuitem']");
    firstItem?.focus();
    const onPointer = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) closeAccountMenu();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (event.defaultPrevented) return;
      if (
        [...document.querySelectorAll('[role="dialog"]')].some(
          (el) => el.getAttribute("aria-labelledby") !== "task-detail-title",
        )
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeAccountMenu();
    };
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget as Node | null;
      if (next && menuRef.current?.contains(next)) return;
      closeAccountMenu();
    };
    const menuRoot = menuRef.current;
    document.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey, true);
    menuRoot?.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey, true);
      menuRoot?.removeEventListener("focusout", onFocusOut);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!me.data) return;
    let stopped = false;
    async function pollReminders() {
      if (!navigator.onLine) return;
      try {
        const rows = await api.pendingReminders();
        if (stopped) return;
        reminderPollFailed.current = false;
        for (const row of rows) {
          if (noticing.current.has(row.id)) continue;
          noticing.current.add(row.id);
          let closed = false;
          const reminderId = row.id;
          function dismissDueReminder() {
            if (closed) return;
            const focusSync = () => focusShellControl("sync-status", "appearance-toggle");
            if (!navigator.onLine) {
              toast.push("You are offline. Reconnect to dismiss the reminder.");
              focusSync();
              return;
            }
            closed = true;
            noticing.current.delete(reminderId);
            void api
              .ackReminder(reminderId)
              .then(() => {
                toast.push("Reminder dismissed.", {
                  label: "Undo",
                  run: () => {
                    const focusSync = () => focusShellControl("sync-status", "appearance-toggle");
                    if (!navigator.onLine) {
                      toast.push("You are offline. Reconnect to restore the reminder.");
                      focusSync();
                      return;
                    }
                    void api
                      .unackReminder(reminderId)
                      .then(() => {
                        noticing.current.delete(reminderId);
                        toast.push("Reminder is due again.");
                        focusSync();
                      })
                      .catch((error: unknown) => {
                        toast.push(error instanceof ApiError ? error.message : "Could not restore the reminder.");
                        focusSync();
                      });
                  },
                });
                focusSync();
              })
              .catch((error: unknown) => {
                closed = false;
                toast.push(error instanceof ApiError ? error.message : "Could not dismiss the reminder.");
                focusSync();
              });
          }
          const notice = toast.push(row.title, [
            {
              label: "Snooze 15 min",
              run: () => {
                if (closed) return;
                const focusSync = () => focusShellControl("sync-status", "appearance-toggle");
                if (!navigator.onLine) {
                  toast.push("You are offline. Reconnect to snooze the reminder.");
                  focusSync();
                  return;
                }
                closed = true;
                noticing.current.delete(reminderId);
                const previousFireAt = row.fireAt;
                void api
                  .snoozeReminder(reminderId, { minutes: 15 })
                  .then(() => {
                    toast.push("Reminder snoozed for 15 minutes.", {
                      label: "Undo",
                      run: () => {
                        const focusSync = () => focusShellControl("sync-status", "appearance-toggle");
                        if (!navigator.onLine) {
                          toast.push("You are offline. Reconnect to restore the reminder time.");
                          focusSync();
                          return;
                        }
                        void api
                          .snoozeReminder(reminderId, { fireAt: previousFireAt })
                          .then(() => {
                            noticing.current.delete(reminderId);
                            toast.push("Restored the reminder time.");
                            focusSync();
                          })
                          .catch((error: unknown) => {
                            toast.push(error instanceof ApiError ? error.message : "Could not restore the reminder time.");
                            focusSync();
                          });
                      },
                    });
                    focusSync();
                  })
                  .catch((error: unknown) => {
                    closed = false;
                    toast.push(error instanceof ApiError ? error.message : "Could not snooze the reminder.");
                    focusSync();
                  });
              },
            },
            {
              label: "Dismiss",
              run: () => dismissDueReminder(),
            },
          ]);
          await window.keepx?.notify({ title: appName(), body: row.title });
          window.setTimeout(() => {
            if (closed) {
              noticing.current.delete(reminderId);
              return;
            }
            notice.dismiss();
            if (!navigator.onLine) {
              noticing.current.delete(reminderId);
              return;
            }
            dismissDueReminder();
          }, 6000);
        }
      } catch (error: unknown) {
        if (stopped || reminderPollFailed.current) return;
        reminderPollFailed.current = true;
        toast.push(error instanceof ApiError ? error.message : "Could not check for due reminders.");
        focusShellControl("sync-status", "appearance-toggle");
      }
    }
    void pollReminders();
    const timer = window.setInterval(() => void pollReminders(), 30_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [me.data, toast]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = isTextEntry(target);
      const otherDialog = [...document.querySelectorAll('[role="dialog"]')].some(
        (el) => el.getAttribute("aria-labelledby") !== "task-detail-title",
      );
      if (event.key === "/" && !typing) {
        if (event.defaultPrevented) return;
        if (otherDialog) return;
        event.preventDefault();
        document.getElementById("task-search")?.focus();
      }
      if (event.key === "[" && !typing) {
        if (event.defaultPrevented) return;
        if (otherDialog) return;
        event.preventDefault();
        setCollapsed((current) => {
          const next = !current;
          localStorage.setItem("vela-sidebar", next ? "collapsed" : "open");
          return next;
        });
      }
      if (event.key === "?" && !typing) {
        if (event.defaultPrevented) return;
        if (otherDialog) return;
        event.preventDefault();
        router.push("/help");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  async function createList(form: FormData) {
    if (!online) {
      toast.push(listDraft ? "You are offline. Reconnect to save the list." : "You are offline. Reconnect to create a list.");
      focusShellControl("list-name", "list-color", "list-editor-close", "new-list", "appearance-toggle");
      return;
    }
    const name = String(form.get("name") ?? "");
    const color = String(form.get("color") ?? "clay");
    const icon = String(form.get("icon") ?? "star");
    try {
      if (listDraft) {
        const previous = {
          id: listDraft.id,
          name: listDraft.name,
          color: listDraft.color,
          icon: listDraft.icon,
          isInbox: listDraft.isInbox,
        };
        const nextName = previous.isInbox ? previous.name : name.trim();
        if (!previous.isInbox && !nextName) {
          toast.push("Choose a list name.");
          focusShellControl("list-name", "list-color", "list-editor-close", "new-list", "appearance-toggle");
          return;
        }
        if (nextName === previous.name && color === previous.color && icon === previous.icon) {
          toast.push("That list already has that name, color, and icon.");
          closeListEditor();
          return;
        }
        await api.updateList(previous.id, previous.isInbox ? { color, icon } : { name: nextName, color, icon });
        await queryClient.invalidateQueries({ queryKey: ["lists"] });
        closeListEditor();
        toast.push("List saved.", {
          label: "Undo",
          run: () => {
            const focusNewList = () => focusShellControl("new-list", "appearance-toggle");
            if (!navigator.onLine) {
              toast.push("You are offline. Reconnect to restore the list.");
              focusNewList();
              return;
            }
            void api
              .updateList(
                previous.id,
                previous.isInbox
                  ? { color: previous.color, icon: previous.icon }
                  : { name: previous.name, color: previous.color, icon: previous.icon },
              )
              .then(() => queryClient.invalidateQueries({ queryKey: ["lists"] }))
              .then(() => {
                toast.push("Restored the list.");
                focusNewList();
              })
              .catch((error: unknown) => {
                void queryClient.invalidateQueries({ queryKey: ["lists"] });
                toast.push(error instanceof ApiError ? error.message : "Could not restore the list.");
                focusNewList();
              });
          },
        });
        return;
      }
      const trimmedName = name.trim();
      if (!trimmedName) {
        toast.push("Choose a list name.");
        focusShellControl("list-name", "list-color", "list-editor-close", "new-list", "appearance-toggle");
        return;
      }
      const created = await api.createList({ name: trimmedName, color, icon });
      await queryClient.invalidateQueries({ queryKey: ["lists"] });
      closeListEditor();
      const createdId = created.id;
      toast.push("List created.", {
        label: "Undo",
        run: () => {
          const focusNewList = () => focusShellControl("new-list", "appearance-toggle");
          if (!navigator.onLine) {
            toast.push("You are offline. Reconnect to delete that list.");
            focusNewList();
            return;
          }
          void api
            .deleteList(createdId)
            .then(async () => {
              if (pathname === `/lists/${createdId}`) router.push("/inbox");
              await queryClient.invalidateQueries({ queryKey: ["lists"] });
              await queryClient.invalidateQueries({ queryKey: ["tasks"] });
              toast.push("Removed the list.");
              focusNewList();
            })
            .catch((error: unknown) => {
              void queryClient.invalidateQueries({ queryKey: ["lists"] });
              toast.push(error instanceof ApiError ? error.message : "Could not delete the list.");
              focusNewList();
            });
        },
      });
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not save the list.");
      focusShellControl(
        ...(listDraft?.isInbox ? ["list-color", "list-name"] : ["list-name", "list-color"]),
        "list-editor-close",
        "new-list",
        "appearance-toggle",
      );
    }
  }

  function applyTheme(theme: "light" | "dark" | "system") {
    localStorage.setItem("vela-theme", theme);
    const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
    setDarkAppearance(dark);
  }

  function toggleTheme() {
    const focusToggle = () => queueMicrotask(() => document.getElementById("appearance-toggle")?.focus());
    const stored = localStorage.getItem("vela-theme");
    const previous = stored === "light" || stored === "dark" || stored === "system" ? stored : document.documentElement.classList.contains("dark") ? "dark" : "light";
    const next = document.documentElement.classList.contains("dark") ? "light" : "dark";
    applyTheme(next);
    toast.push(`Appearance set to ${next}.`, {
      label: "Undo",
      run: () => {
        applyTheme(previous);
        toast.push(`Appearance set to ${previous}.`);
        focusToggle();
      },
    });
    focusToggle();
  }

  async function logout() {
    const focusSignOut = () =>
      queueMicrotask(() => {
        const button = document.getElementById("sign-out");
        if (canFocusShellControl(button)) button.focus();
        else accountButtonRef.current?.focus();
      });
    if (!online) {
      toast.push("You are offline. Reconnect to sign out.");
      focusSignOut();
      return;
    }
    try {
      await api.logout();
      closeAccountMenu();
      queryClient.clear();
      router.replace("/login");
      router.refresh();
    } catch (error: unknown) {
      toast.push(error instanceof ApiError ? error.message : "Could not sign out.");
      focusSignOut();
    }
  }

  function copyList(list: ListDto) {
    const focusCopy = () =>
      focusShellQuery(`[data-list-action="copy-${list.id}"]`, "#new-list", "#appearance-toggle");
    if (!online) {
      toast.push("You are offline. Reconnect to copy the list.");
      focusCopy();
      return;
    }
    void api
      .duplicateList(list.id)
      .then(async (copy) => {
        await queryClient.invalidateQueries({ queryKey: ["lists"] });
        await queryClient.invalidateQueries({ queryKey: ["tasks"] });
        focusCopy();
        const tasks =
          copy.copiedTasks === 0
            ? " It has no open tasks to copy."
            : copy.copiedTasks === 1
              ? " Its task is open."
              : ` Its ${copy.copiedTasks} tasks are open.`;
        const copyId = copy.id;
        toast.push(`List copied. The new list is private.${tasks}`, {
          label: "Undo",
          run: () => {
            if (!navigator.onLine) {
              toast.push("You are offline. Reconnect to remove the list copy.");
              focusCopy();
              return;
            }
            void api
              .deleteList(copyId)
              .then(async () => {
                if (pathname === `/lists/${copyId}`) router.push("/inbox");
                await queryClient.invalidateQueries({ queryKey: ["lists"] });
                await queryClient.invalidateQueries({ queryKey: ["tasks"] });
                toast.push("Removed the list copy.");
                focusCopy();
              })
              .catch((error: unknown) => {
                void queryClient.invalidateQueries({ queryKey: ["lists"] });
                toast.push(error instanceof ApiError ? error.message : "Could not remove the list copy.");
                focusCopy();
              });
          },
        });
      })
      .catch((error: unknown) => {
        toast.push(error instanceof ApiError ? error.message : "Could not copy the list.");
        focusCopy();
      });
  }

  function removeList(list: ListDto) {
    const focusDelete = () =>
      focusShellControl("delete-list", "cancel-delete-list", "delete-list-dialog-close", "new-list", "appearance-toggle");
    if (!online) {
      toast.push("You are offline. Reconnect to delete the list.");
      focusDelete();
      return;
    }
    void (async () => {
      try {
        const previous = { name: list.name, color: list.color, icon: list.icon };
        const [openTasks, completedTasks, archivedTasks, memberRows] = await Promise.all([
          api.listTasks({ view: "list", listId: list.id }),
          api.listTasks({ view: "completed", listId: list.id }),
          api.listTasks({ view: "archived", listId: list.id }),
          api.listMembers(list.id),
        ]);
        const taskIds = [
          ...new Set([
            ...openTasks.tasks.map((task) => task.id),
            ...completedTasks.tasks.map((task) => task.id),
            ...archivedTasks.tasks.map((task) => task.id),
          ]),
        ];
        const editorEmails = memberRows.filter((member) => member.role === "editor").map((member) => member.email);
        await api.deleteList(list.id);
        closeDeleteList();
        if (pathname === `/lists/${list.id}`) router.push("/inbox");
        await queryClient.invalidateQueries({ queryKey: ["lists"] });
        await queryClient.invalidateQueries({ queryKey: ["tasks"] });
        toast.push("List deleted. Its tasks are in Inbox.", {
          label: "Undo",
          run: () => {
            const focusAfterDelete = () => focusDelete();
            if (!navigator.onLine) {
              toast.push("You are offline. Reconnect to restore that list.");
              focusAfterDelete();
              return;
            }
            void (async () => {
              try {
                const created = await api.createList({
                  name: previous.name,
                  color: previous.color,
                  icon: previous.icon,
                });
                for (let index = 0; index < taskIds.length; index += 100) {
                  const chunk = taskIds.slice(index, index + 100);
                  if (chunk.length === 0) continue;
                  await api.batchTasks({ ids: chunk, action: "move", listId: created.id });
                }
                for (const email of editorEmails) {
                  await api.shareList(created.id, { email });
                }
                await queryClient.invalidateQueries({ queryKey: ["lists"] });
                await queryClient.invalidateQueries({ queryKey: ["tasks"] });
                toast.push("Restored the list.");
                focusAfterDelete();
              } catch (error: unknown) {
                void queryClient.invalidateQueries({ queryKey: ["lists"] });
                void queryClient.invalidateQueries({ queryKey: ["tasks"] });
                toast.push(error instanceof ApiError ? error.message : "Could not restore the list.");
                focusAfterDelete();
              }
            })();
          },
        });
      } catch (error: unknown) {
        toast.push(error instanceof ApiError ? error.message : "Could not delete the list.");
        focusDelete();
      }
    })();
  }

  function setListArchived(id: string, archived: boolean) {
    const focusListAction = (action: string) =>
      focusShellQuery(`[data-list-action="${action}-${id}"]`, "#new-list", "#appearance-toggle");
    const focusArchive = () => focusListAction(archived ? "archive" : "restore");
    if (!online) {
      toast.push(archived ? "You are offline. Reconnect to archive that list." : "You are offline. Reconnect to restore that list.");
      focusArchive();
      return;
    }
    const name = (lists.data ?? []).find((list) => list.id === id)?.name ?? "the list";
    void api
      .updateList(id, { archived })
      .then(async () => {
        await queryClient.invalidateQueries({ queryKey: ["lists"] });
        focusListAction(archived ? "restore" : "archive");
        toast.push(archived ? `Archived ${name}.` : `Restored ${name}.`, {
          label: "Undo",
          run: () => {
            const focusUndo = () =>
              focusShellQuery(
                `[data-list-action="${archived ? "restore" : "archive"}-${id}"]`,
                `[data-list-action="${archived ? "archive" : "restore"}-${id}"]`,
                "#new-list",
                "#appearance-toggle",
              );
            if (!navigator.onLine) {
              toast.push(
                archived
                  ? "You are offline. Reconnect to restore that list."
                  : "You are offline. Reconnect to archive that list.",
              );
              focusUndo();
              return;
            }
            void api
              .updateList(id, { archived: !archived })
              .then(() => queryClient.invalidateQueries({ queryKey: ["lists"] }))
              .then(() => {
                toast.push(archived ? `Restored ${name}.` : `Archived ${name}.`);
                focusUndo();
              })
              .catch((error: unknown) => {
                void queryClient.invalidateQueries({ queryKey: ["lists"] });
                toast.push(
                  error instanceof ApiError
                    ? error.message
                    : archived
                      ? "Could not restore that list."
                      : "Could not archive that list.",
                );
                focusUndo();
              });
          },
        });
      })
      .catch((error: unknown) => {
        toast.push(
          error instanceof ApiError
            ? error.message
            : archived
              ? "Could not archive that list."
              : "Could not restore that list.",
        );
        focusArchive();
      });
  }

  const activeLists = (lists.data ?? []).filter((list) => !list.archivedAt);
  const ownedMovable = (lists.data ?? [])
    .filter((list) => list.role === "owner" && !list.isInbox)
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const visibleMovable = ownedMovable.filter((list) => !list.archivedAt);

  function moveList(id: string, direction: -1 | 1) {
    const action = direction < 0 ? "up" : "down";
    const focusMove = () =>
      focusShellQuery(
        `[data-list-action="${action}-${id}"]`,
        `[data-list-action="${action === "up" ? "down" : "up"}-${id}"]`,
        "#new-list",
        "#appearance-toggle",
      );
    if (!online) {
      toast.push("You are offline. Reconnect to reorder lists.");
      focusMove();
      return;
    }
    const index = visibleMovable.findIndex((list) => list.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= visibleMovable.length) return;
    const current = visibleMovable[index];
    const destination = visibleMovable[target];
    if (!current || !destination) return;
    const previous = ownedMovable.map((list) => list.id);
    const next = [...previous];
    const from = next.indexOf(current.id);
    const to = next.indexOf(destination.id);
    if (from < 0 || to < 0) return;
    next[from] = destination.id;
    next[to] = current.id;
    const changed = next.filter((id, index) => previous[index] !== id).length;
    if (changed === 0) return;
    const unchanged = next.length - changed;
    void api
      .reorderLists(next)
      .then(() => {
        queryClient.invalidateQueries({ queryKey: ["lists"] });
        focusMove();
        const main = changed === 1 ? "Reordered 1 list." : `Reordered ${changed} lists.`;
        const rest = unchanged === 0 ? "" : unchanged === 1 ? " 1 was already in place." : ` ${unchanged} were already in place.`;
        toast.push(`${main}${rest}`, {
          label: "Undo",
          run: () => {
            if (!navigator.onLine) {
              toast.push("You are offline. Reconnect to restore the previous list order.");
              focusMove();
              return;
            }
            void api
              .reorderLists(previous)
              .then(() => queryClient.invalidateQueries({ queryKey: ["lists"] }))
              .then(() => {
                toast.push("Restored the previous list order.");
                focusMove();
              })
              .catch((error: unknown) => {
                void queryClient.invalidateQueries({ queryKey: ["lists"] });
                toast.push(error instanceof ApiError ? error.message : "Could not reorder lists.");
                focusMove();
              });
          },
        });
      })
      .catch((error: unknown) => {
        toast.push(error instanceof ApiError ? error.message : "Could not reorder lists.");
        focusMove();
      });
  }

  return (
    <div className="min-h-screen md:grid md:grid-cols-[auto_1fr]">
      <a className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:bg-surface focus:px-3 focus:py-2" href="#content">
        Skip to content
      </a>
      <aside id="app-sidebar" className={`${collapsed ? "md:w-16" : "md:w-64"} hidden border-r border-line bg-surface md:flex md:flex-col`}>
        <div className="flex items-center gap-2 px-3 py-4">
          <Mark className="h-8 w-8 shrink-0" />
          {collapsed ? null : <span className="font-semibold text-accent">{appName()}</span>}
          <button
            className="ml-auto rounded-md p-1 hover:bg-surface"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            aria-controls="app-sidebar"
            type="button"
            onClick={() => {
              const next = !collapsed;
              setCollapsed(next);
              localStorage.setItem("vela-sidebar", next ? "collapsed" : "open");
            }}
          >
            <Menu className="h-4 w-4" />
          </button>
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-2">
          {nav.map((item) => (
            <NavLink
              key={item.href}
              href={item.href}
              label={item.label}
              collapsed={collapsed}
              active={navItemActive(pathname, item.href)}
              icon={item.icon}
            />
          ))}
          <div className="mt-4 px-2 text-xs uppercase tracking-wide text-muted">{collapsed ? "" : "Lists"}</div>
          {lists.isError ? (
            collapsed ? (
              <button
                className="mx-2 mb-2 rounded-lg border border-line bg-bg px-2 py-2 text-xs text-accent"
                type="button"
                title="Lists could not be loaded. Try again"
                aria-label="Lists could not be loaded. Try again"
                onClick={() => void lists.refetch()}
              >
                !
              </button>
            ) : (
              <div className="mx-2 mb-2 rounded-lg border border-line bg-bg px-2 py-2 text-xs">
                <p>Lists could not be loaded.</p>
                <button className="mt-1 text-accent" type="button" aria-label="Lists could not be loaded. Try again" onClick={() => void lists.refetch()}>
                  Try again
                </button>
              </div>
            )
          ) : lists.isLoading ? (
            collapsed ? (
              <p className="mx-2 mb-2 px-2 text-xs text-muted" title="Loading lists" role="status" aria-label="Loading lists">
                …
              </p>
            ) : (
              <p className="mx-2 mb-2 px-2 text-xs text-muted" role="status">
                Loading lists…
              </p>
            )
          ) : null}
          {activeLists.map((list) => (
            <div key={list.id} className="flex items-center">
              <Link
                href={`/lists/${list.id}`}
                aria-label={collapsed ? list.name : undefined}
                aria-current={pathname === `/lists/${list.id}` ? "page" : undefined}
                className={`min-w-0 flex-1 truncate rounded-xl px-2 py-2 text-sm hover:bg-surface ${pathname === `/lists/${list.id}` ? "bg-accent/10 font-medium text-accent" : "text-muted"}`}
                title={list.name}
              >
                <ListDot list={list} />
                {collapsed ? null : <span className="ml-2">{list.name}</span>}
                {!collapsed && list.role === "editor" ? <span className="ml-2 text-xs">Shared</span> : null}
              </Link>
              {!collapsed && list.role === "owner" && !list.isInbox && visibleMovable.length > 1 ? (
                <span className="flex flex-col">
                  <button
                    className="px-1 text-[10px] leading-none text-muted disabled:opacity-30"
                    type="button"
                    data-list-action={`up-${list.id}`}
                    aria-label={`Move ${list.name} up`}
                    disabled={!online || visibleMovable[0]?.id === list.id}
                    onClick={() => moveList(list.id, -1)}
                  >
                    Up
                  </button>
                  <button
                    className="px-1 text-[10px] leading-none text-muted disabled:opacity-30"
                    type="button"
                    data-list-action={`down-${list.id}`}
                    aria-label={`Move ${list.name} down`}
                    disabled={!online || visibleMovable[visibleMovable.length - 1]?.id === list.id}
                    onClick={() => moveList(list.id, 1)}
                  >
                    Down
                  </button>
                </span>
              ) : null}
              {!collapsed ? (
                <button
                  className="rounded-md px-2 py-1 text-xs text-muted hover:bg-surface disabled:opacity-50"
                  type="button"
                  data-list-action={`copy-${list.id}`}
                  aria-label={`Copy ${list.name}`}
                  disabled={!online}
                  onClick={() => copyList(list)}
                >
                  Copy
                </button>
              ) : null}
              {!collapsed && list.role === "owner" ? (
                <button
                  className="rounded-md px-2 py-1 text-xs text-muted hover:bg-surface disabled:opacity-50"
                  type="button"
                  aria-label={`Edit ${list.name}`}
                  aria-haspopup="dialog"
                  aria-expanded={listOpen && listDraft?.id === list.id}
                  aria-controls="list-editor"
                  disabled={!online}
                  onClick={() => openListEditor(list)}
                >
                  Edit
                </button>
              ) : null}
              {!collapsed && list.role === "owner" && !list.isInbox ? (
                <button
                  className="rounded-md px-2 py-1 text-xs text-muted hover:bg-surface disabled:opacity-50"
                  type="button"
                  data-list-action={`archive-${list.id}`}
                  aria-label={`Archive ${list.name}`}
                  disabled={!online}
                  onClick={() => setListArchived(list.id, true)}
                >
                  Archive
                </button>
              ) : null}
              {!collapsed && list.role === "owner" && !list.isInbox ? (
                <button
                  className="rounded-md px-2 py-1 text-xs text-muted hover:bg-surface disabled:opacity-50"
                  type="button"
                  aria-label={`Delete ${list.name}`}
                  aria-haspopup="dialog"
                  aria-expanded={listToDelete?.id === list.id}
                  aria-controls="delete-list-dialog"
                  disabled={!online}
                  onClick={() => openDeleteList(list)}
                >
                  Delete
                </button>
              ) : null}
              {!collapsed && !list.isInbox ? (
                <button
                  className="rounded-md px-2 py-1 text-xs text-muted hover:bg-surface disabled:opacity-50"
                  type="button"
                  aria-label={`Share ${list.name}`}
                  aria-haspopup="dialog"
                  aria-expanded={shareList?.id === list.id}
                  aria-controls="share-list"
                  disabled={!online}
                  onClick={() => openShare(list)}
                >
                  Share
                </button>
              ) : null}
            </div>
          ))}
          <button
            id="new-list"
            className="rounded-lg px-2 py-2 text-left text-sm text-muted hover:bg-surface disabled:opacity-50"
            type="button"
            aria-label="New list"
            aria-haspopup="dialog"
            aria-expanded={listOpen && !listDraft}
            aria-controls="list-editor"
            disabled={!online}
            onClick={() => openListEditor(null)}
          >
            {collapsed ? "+" : "New list"}
          </button>
          {!collapsed && (lists.data ?? []).some((list) => list.role === "owner" && list.archivedAt) ? (
            <div className="mt-3">
              <div id="archived-lists" className="px-2 text-xs uppercase tracking-wide text-muted" tabIndex={-1}>
                Archived
              </div>
              {(lists.data ?? [])
                .filter((list) => list.role === "owner" && list.archivedAt)
                .map((list) => (
                  <div key={list.id} className="flex items-center">
                    <span className="min-w-0 flex-1 truncate px-2 py-2 text-sm text-muted">{list.name}</span>
                    <button
                      className="rounded-md px-2 py-1 text-xs text-accent disabled:opacity-50"
                      type="button"
                      data-list-action={`restore-${list.id}`}
                      aria-label={`Restore ${list.name}`}
                      disabled={!online}
                      onClick={() => setListArchived(list.id, false)}
                    >
                      Restore
                    </button>
                    <button
                      className="rounded-md px-2 py-1 text-xs text-muted disabled:opacity-50"
                      type="button"
                      data-list-action={`copy-${list.id}`}
                      aria-label={`Copy ${list.name}`}
                      disabled={!online}
                      onClick={() => copyList(list)}
                    >
                      Copy
                    </button>
                    <button
                      className="rounded-md px-2 py-1 text-xs text-muted disabled:opacity-50"
                      type="button"
                      aria-label={`Delete ${list.name}`}
                      aria-haspopup="dialog"
                      aria-expanded={listToDelete?.id === list.id}
                      aria-controls="delete-list-dialog"
                      disabled={!online}
                      onClick={() => openDeleteList(list)}
                    >
                      Delete
                    </button>
                  </div>
                ))}
            </div>
          ) : null}
        </nav>
      </aside>
      <div className="flex min-h-screen min-w-0 flex-col">
        <header className="flex items-center gap-2 border-b border-line bg-bg/80 px-3 py-3 backdrop-blur md:px-5">
          <SearchField pathname={pathname} />
          <SyncStatus
            phase={sync.phase}
            count={sync.mutations.length}
            disabled={!online}
            onRetry={() => {
              const focusSync = () => focusShellControl("sync-status", "appearance-toggle");
              if (!online) {
                toast.push("You are offline. Reconnect to sync.");
                focusSync();
                return;
              }
              if (sync.phase === "synced") {
                toast.push("Everything is synced.");
                focusSync();
                return;
              }
              void sync
                .retryNow()
                .then((result) => {
                  if (result.remaining === 0) {
                    toast.push("Everything is synced.");
                  } else if (result.attention > 0 && result.attention === result.remaining) {
                    toast.push(
                      result.attention === 1
                        ? "That change still needs your choice."
                        : "Those changes still need your choice.",
                    );
                  } else if (result.attention > 0) {
                    toast.push(
                      result.remaining === 1
                        ? "1 change is still waiting. Some need your choice."
                        : `${result.remaining} changes are still waiting. Some need your choice.`,
                    );
                  } else {
                    toast.push(
                      result.remaining === 1
                        ? "1 change is still waiting to sync."
                        : `${result.remaining} changes are still waiting to sync.`,
                    );
                  }
                  focusSync();
                })
                .catch((error: unknown) => {
                  toast.push(error instanceof ApiError ? error.message : "Could not sync.");
                  focusSync();
                });
            }}
          />
          <button
            id="appearance-toggle"
            className="rounded-lg p-2 hover:bg-sidebar"
            type="button"
            aria-label={darkAppearance ? "Use light appearance" : "Use dark appearance"}
            aria-pressed={darkAppearance}
            onClick={toggleTheme}
          >
            <Moon className="h-4 w-4 dark:hidden" aria-hidden="true" />
            <Sun className="hidden h-4 w-4 dark:block" aria-hidden="true" />
          </button>
          <div className="relative" ref={menuRef}>
            <button
              ref={accountButtonRef}
              className="rounded-lg px-2 py-1 text-sm hover:bg-sidebar"
              type="button"
              aria-label="Account"
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              aria-controls="account-menu"
              onClick={() => setMenuOpen((open) => !open)}
            >
              {me.data?.name ?? "Account"}
            </button>
            {menuOpen ? (
              <div
                id="account-menu"
                className="absolute right-0 z-20 mt-2 w-44 rounded-lg border border-line bg-surface p-1 shadow-lg"
                role="menu"
              >
                <Link
                  className={`block rounded-md px-2 py-2 text-sm hover:bg-sidebar ${pathname === "/help" ? "bg-accent/10 font-medium text-accent" : ""}`}
                  href="/help"
                  role="menuitem"
                  aria-current={pathname === "/help" ? "page" : undefined}
                  onClick={closeAccountMenu}
                >
                  Help
                </Link>
                <Link
                  className={`block rounded-md px-2 py-2 text-sm hover:bg-sidebar ${pathname === "/settings" ? "bg-accent/10 font-medium text-accent" : ""}`}
                  href="/settings"
                  role="menuitem"
                  aria-current={pathname === "/settings" ? "page" : undefined}
                  onClick={closeAccountMenu}
                >
                  Settings
                </Link>
                <button
                  id="sign-out"
                  className={`block w-full rounded-md px-2 py-2 text-left text-sm hover:bg-sidebar ${online ? "" : "opacity-50"}`}
                  type="button"
                  role="menuitem"
                  aria-label="Sign out of KeepX"
                  aria-disabled={!online}
                  onClick={logout}
                >
                  Sign out
                </button>
              </div>
            ) : null}
          </div>
        </header>
        {!online ? (
          <p className="bg-sidebar px-4 py-2 text-sm">
            You are offline. Task edits stay on this device and sync when you reconnect. Lists, tags, and other
            actions need a connection.
          </p>
        ) : null}
        {sync.mutations.some((item) => item.attention?.length) ? (
          <div className="flex flex-col gap-2 bg-accent/10 px-4 py-2 text-sm">
            {sync.mutations
              .filter((item) => item.attention?.length)
              .map((item) => {
                const fields = (item.attention ?? []).filter((field) => field !== "request");
                const failed = (item.attention ?? []).includes("request");
                const title =
                  typeof item.payload.title === "string"
                    ? item.payload.title
                    : typeof item.base.title === "string"
                      ? item.base.title
                      : "this change";
                return (
                  <div key={item.id} className="flex flex-wrap items-center gap-3">
                    <p>
                      {failed
                        ? "A change could not sync after several tries. Choose which copy to keep."
                        : fields.length > 0
                          ? `A newer edit is on the server for ${fields.join(", ")}. Choose which copy to keep.`
                          : "A newer edit is on the server. Choose which copy to keep."}
                    </p>
                    <button
                      id={`keep-mine-${item.id}`}
                      className="font-medium text-accent disabled:opacity-50"
                      type="button"
                      aria-label={`Keep mine for ${title}`}
                      disabled={!online}
                      onClick={() => {
                        if (!online) {
                          toast.push("You are offline. Reconnect to keep your copy.");
                          focusShellControl("sync-status", "appearance-toggle", `keep-mine-${item.id}`);
                          return;
                        }
                        void sync
                          .choose(item.id, "local")
                          .then(() => {
                            toast.push("Kept your copy.");
                            focusShellControl("sync-status", "appearance-toggle", `keep-mine-${item.id}`);
                          })
                          .catch((error: unknown) => {
                            toast.push(error instanceof ApiError ? error.message : "Could not keep your copy.");
                            focusShellControl(`keep-mine-${item.id}`, "appearance-toggle");
                          });
                      }}
                    >
                      Keep mine
                    </button>
                    <button
                      id={`keep-server-${item.id}`}
                      className="font-medium text-accent"
                      type="button"
                      aria-label={`Keep server for ${title}`}
                      onClick={() => {
                        void sync
                          .choose(item.id, "server")
                          .then(() => {
                            toast.push("Kept the server copy.");
                            focusShellControl("sync-status", "appearance-toggle", `keep-server-${item.id}`);
                          })
                          .catch((error: unknown) => {
                            toast.push(error instanceof ApiError ? error.message : "Could not keep the server copy.");
                            focusShellControl(`keep-server-${item.id}`, "appearance-toggle");
                          });
                      }}
                    >
                      Keep server
                    </button>
                  </div>
                );
              })}
          </div>
        ) : null}
        <div id="content" className="min-w-0 flex-1 pb-20 md:pb-0" tabIndex={-1}>
          {children}
        </div>
      </div>
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden">
        {[
          { href: "/today", label: "Today", icon: Sun },
          { href: "/inbox", label: "Inbox", icon: Inbox },
          { href: "/upcoming", label: "Upcoming", icon: CalendarClock },
          { href: "/search", label: "Search", icon: Search },
        ].map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-current={pathname === item.href ? "page" : undefined}
            className={`flex flex-col items-center gap-1 py-2 text-[11px] ${pathname === item.href ? "font-medium text-accent" : "text-muted"}`}
          >
            <item.icon className="h-4 w-4" aria-hidden="true" />
            {item.label}
          </Link>
        ))}
        <button
          ref={moreButtonRef}
          className={`flex flex-col items-center gap-1 py-2 text-[11px] ${
            moreOpen ||
            pathname === "/help" ||
            pathname === "/settings" ||
            pathname.startsWith("/lists/") ||
            pathname.startsWith("/tags/") ||
            nav.some((item) => navItemActive(pathname, item.href) && !["/today", "/inbox", "/upcoming"].includes(item.href))
              ? "font-medium text-accent"
              : "text-muted"
          }`}
          type="button"
          aria-label="More menu"
          aria-expanded={moreOpen}
          aria-haspopup="dialog"
          aria-controls="more-menu"
          aria-current={
            !moreOpen &&
            (pathname === "/help" ||
              pathname === "/settings" ||
              pathname.startsWith("/lists/") ||
              pathname.startsWith("/tags/") ||
              nav.some((item) => navItemActive(pathname, item.href) && !["/today", "/inbox", "/upcoming"].includes(item.href)))
              ? "page"
              : undefined
          }
          onClick={() => setMoreOpen(true)}
        >
          <Menu className="h-4 w-4" aria-hidden="true" />
          More
        </button>
      </nav>
      <Dialog
        open={moreOpen}
        onOpenChange={(open) => {
          if (open) setMoreOpen(true);
          else closeMoreMenu();
        }}
        title="More menu"
        contentId="more-menu"
      >
        <div className="grid gap-2">
          {nav.map((item, index) => (
            <Link
              key={item.href}
              href={item.href}
              autoFocus={index === 0}
              aria-current={navItemActive(pathname, item.href) ? "page" : undefined}
              className={`rounded-lg px-2 py-2 hover:bg-sidebar ${navItemActive(pathname, item.href) ? "bg-accent/10 font-medium text-accent" : ""}`}
              onClick={closeMoreMenu}
            >
              {item.label}
            </Link>
          ))}
          <Link
            href="/help"
            aria-current={pathname === "/help" ? "page" : undefined}
            className={`inline-flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-sidebar ${pathname === "/help" ? "bg-accent/10 font-medium text-accent" : ""}`}
            onClick={closeMoreMenu}
          >
            <CircleHelp className="h-4 w-4" aria-hidden="true" /> Help
          </Link>
          <Link
            href="/settings"
            aria-current={pathname === "/settings" ? "page" : undefined}
            className={`inline-flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-sidebar ${pathname === "/settings" ? "bg-accent/10 font-medium text-accent" : ""}`}
            onClick={closeMoreMenu}
          >
            <Settings className="h-4 w-4" aria-hidden="true" /> Settings
          </Link>
        </div>
      </Dialog>
      <Dialog
        open={Boolean(shareList)}
        onOpenChange={(open) => {
          if (!open) closeShare();
        }}
        title={shareList ? `Share ${shareList.name}` : "Share"}
        contentId="share-list"
      >
        {shareList?.role === "editor" ? (
          <div className="space-y-3 text-sm">
            <p className="text-muted">You can add and edit tasks here. Only the owner can invite someone else.</p>
            {members.isError ? (
              <div>
                <p>People on this list could not be loaded.</p>
                <button className="mt-1 text-accent" type="button" aria-label="People on this list could not be loaded. Try again" onClick={() => void members.refetch()}>
                  Try again
                </button>
              </div>
            ) : members.isLoading ? (
              <p className="text-muted" role="status">
                Loading people…
              </p>
            ) : (
              <ul className="space-y-1">
                {(members.data ?? []).map((member) => (
                  <li key={member.id}>
                    {member.email} · {member.role}
                  </li>
                ))}
              </ul>
            )}
            {!online ? <p className="text-sm text-muted">You are offline. Reconnect to leave the list.</p> : null}
            <Button
              id="leave-list"
              type="button"
              variant="secondary"
              aria-label={`Leave ${shareList.name}`}
              disabled={!online}
              onClick={() => {
                if (!shareList || !me.data) return;
                const focusLeave = () => focusShellControl("leave-list", "share-list-close", "new-list", "appearance-toggle");
                if (!online) {
                  toast.push("You are offline. Reconnect to leave the list.");
                  focusLeave();
                  return;
                }
                const listId = shareList.id;
                void api
                  .removeMember(listId, me.data.id)
                  .then(async () => {
                    shareOpenerRef.current = null;
                    setShareList(null);
                    setShareEmail("");
                    if (pathname === `/lists/${listId}`) router.push("/inbox");
                    await queryClient.invalidateQueries({ queryKey: ["lists"] });
                    focusLeave();
                    toast.push("You left the list.", {
                      label: "Undo",
                      run: () => {
                        const focusAfterLeave = () => focusLeave();
                        if (!navigator.onLine) {
                          toast.push("You are offline. Reconnect to rejoin the list.");
                          focusAfterLeave();
                          return;
                        }
                        void api
                          .rejoinList(listId)
                          .then(async () => {
                            await queryClient.invalidateQueries({ queryKey: ["lists"] });
                            toast.push("You rejoined the list.");
                            focusAfterLeave();
                          })
                          .catch((error: unknown) => {
                            void queryClient.invalidateQueries({ queryKey: ["lists"] });
                            toast.push(error instanceof ApiError ? error.message : "Could not rejoin the list.");
                            focusAfterLeave();
                          });
                      },
                    });
                  })
                  .catch((error: unknown) => {
                    toast.push(error instanceof ApiError ? error.message : "Could not leave the list.");
                    focusLeave();
                  });
              }}
            >
              Leave list
            </Button>
          </div>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!shareList) return;
              const focusShareEmail = () =>
                focusShellControl("share-email", "share-list-close", "new-list", "appearance-toggle");
              if (!online) {
                toast.push("You are offline. Reconnect to invite someone.");
                focusShareEmail();
                return;
              }
              const listId = shareList.id;
              void api
                .shareList(listId, { email: shareEmail })
                .then(async (member) => {
                  setShareEmail("");
                  await queryClient.invalidateQueries({ queryKey: ["members", listId] });
                  if (!member.added) {
                    toast.push("They already have this list.");
                    focusShareEmail();
                    return;
                  }
                  toast.push("They will see this list the next time they open KeepX. No email is sent.", {
                    label: "Undo",
                    run: () => {
                      if (!navigator.onLine) {
                        toast.push("You are offline. Reconnect to remove that person.");
                        focusShareEmail();
                        return;
                      }
                      void api
                        .removeMember(listId, member.id)
                        .then(() => queryClient.invalidateQueries({ queryKey: ["members", listId] }))
                        .then(() => {
                          toast.push("Removed that person from the list.");
                          focusShareEmail();
                        })
                        .catch((error: unknown) => {
                          void queryClient.invalidateQueries({ queryKey: ["members", listId] });
                          toast.push(error instanceof ApiError ? error.message : "Could not remove that person.");
                          focusShareEmail();
                        });
                    },
                  });
                  focusShareEmail();
                })
                .catch((error: unknown) => {
                  toast.push(error instanceof ApiError ? error.message : "Could not share the list.");
                  focusShareEmail();
                });
            }}
          >
            <p className="text-sm text-muted">Invite an existing account. Inbox stays private, and their other tasks stay hidden.</p>
            {!online ? <p className="text-sm text-muted">You are offline. Reconnect to invite someone.</p> : null}
            <Input
              id="share-email"
              aria-label="Email address"
              type="email"
              value={shareEmail}
              onChange={(event) => setShareEmail(event.target.value)}
              required
              placeholder="name@example.com"
              autoFocus
              disabled={!online}
            />
            <Button type="submit" disabled={!online}>
              Invite
            </Button>
            {members.isError ? (
              <div className="text-sm">
                <p>People on this list could not be loaded.</p>
                <button className="mt-1 text-accent" type="button" aria-label="People on this list could not be loaded. Try again" onClick={() => void members.refetch()}>
                  Try again
                </button>
              </div>
            ) : members.isLoading ? (
              <p className="text-sm text-muted" role="status">
                Loading people…
              </p>
            ) : (
              <ul className="space-y-2 text-sm">
                {(members.data ?? []).map((member) => (
                  <li key={member.id} className="flex items-center justify-between gap-2">
                    <span>
                      {member.email} · {member.role}
                    </span>
                    {member.role === "editor" ? (
                      <button
                        id={`remove-member-${member.id}`}
                        className="text-xs text-muted disabled:opacity-50"
                        type="button"
                        aria-label={`Remove ${member.email}`}
                        disabled={!online}
                        onClick={() => {
                          if (!shareList) return;
                          const memberId = member.id;
                          const focusRemove = () =>
                            focusShellControl(
                              `remove-member-${memberId}`,
                              "share-email",
                              "share-list-close",
                              "appearance-toggle",
                            );
                          if (!online) {
                            toast.push("You are offline. Reconnect to remove that person.");
                            focusRemove();
                            return;
                          }
                          const listId = shareList.id;
                          const memberEmail = member.email;
                          void api
                            .removeMember(listId, memberId)
                            .then(() => queryClient.invalidateQueries({ queryKey: ["members", listId] }))
                            .then(() => {
                              focusRemove();
                              toast.push(`Removed ${memberEmail} from the list.`, {
                                label: "Undo",
                                run: () => {
                                  const focusAfterRemove = () => focusRemove();
                                  if (!navigator.onLine) {
                                    toast.push("You are offline. Reconnect to invite that person again.");
                                    focusAfterRemove();
                                    return;
                                  }
                                  void api
                                    .shareList(listId, { email: memberEmail })
                                    .then(async (restored) => {
                                      await queryClient.invalidateQueries({ queryKey: ["members", listId] });
                                      if (!restored.added) {
                                        toast.push("They already have this list.");
                                        focusAfterRemove();
                                        return;
                                      }
                                      toast.push(`Restored ${memberEmail} on the list.`);
                                      focusAfterRemove();
                                    })
                                    .catch((error: unknown) => {
                                      void queryClient.invalidateQueries({ queryKey: ["members", listId] });
                                      toast.push(error instanceof ApiError ? error.message : "Could not restore that person.");
                                      focusAfterRemove();
                                    });
                                },
                              });
                            })
                            .catch((error: unknown) => {
                              toast.push(error instanceof ApiError ? error.message : "Could not remove that person.");
                              focusRemove();
                            });
                        }}
                      >
                        Remove
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </form>
        )}
      </Dialog>
      <Dialog
        open={listOpen}
        onOpenChange={(open) => {
          if (open) setListOpen(true);
          else closeListEditor();
        }}
        title={listDraft ? `Edit ${listDraft.name}` : "New list"}
        contentId="list-editor"
      >
        <form
          key={listDraft?.id ?? "new"}
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void createList(new FormData(event.currentTarget));
          }}
        >
          {!online ? <p className="text-sm text-muted">You are offline. Reconnect to {listDraft ? "save the list" : "create a list"}.</p> : null}
          <Input
            id="list-name"
            name="name"
            required
            placeholder="List name"
            aria-label="List name"
            defaultValue={listDraft?.name ?? ""}
            disabled={listDraft?.isInbox || !online}
            autoFocus={!listDraft?.isInbox}
          />
          {listDraft?.isInbox ? <p className="text-xs text-muted">Inbox keeps its name. You can change the color and icon.</p> : null}
          <label className="block text-sm">
            Color
            <select
              id="list-color"
              name="color"
              aria-label="List color"
              className="mt-1 h-10 w-full rounded-lg border border-line bg-surface px-2"
              defaultValue={listDraft?.color ?? "clay"}
              disabled={!online}
              autoFocus={Boolean(listDraft?.isInbox)}
            >
              {LIST_COLORS.map((color) => (
                <option key={color} value={color}>
                  {color}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            Icon
            <select
              name="icon"
              aria-label="List icon"
              className="mt-1 h-10 w-full rounded-lg border border-line bg-surface px-2"
              defaultValue={listDraft?.icon ?? "star"}
              disabled={!online}
            >
              {LIST_ICONS.map((icon) => (
                <option key={icon} value={icon}>
                  {icon}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" disabled={!online}>
            {listDraft ? "Save list" : "Create list"}
          </Button>
        </form>
      </Dialog>
      <Dialog
        open={Boolean(listToDelete)}
        onOpenChange={(open) => {
          if (!open) closeDeleteList();
        }}
        title={listToDelete ? `Delete ${listToDelete.name}` : "Delete list"}
        description="Tasks on this list move to the Inbox of the person who added them. Inbox cannot be deleted."
        contentId="delete-list-dialog"
      >
        {!online ? <p className="mb-3 text-sm text-muted">You are offline. Reconnect to delete the list.</p> : null}
        <div className="flex gap-2">
          <Button
            id="delete-list"
            type="button"
            disabled={!online}
            aria-label={listToDelete ? `Delete ${listToDelete.name}` : "Delete list"}
            onClick={() => {
              if (listToDelete) removeList(listToDelete);
            }}
          >
            Delete list
          </Button>
          <Button
            id="cancel-delete-list"
            type="button"
            variant="secondary"
            autoFocus
            aria-label={listToDelete ? `Cancel Delete ${listToDelete.name}` : "Cancel Delete list"}
            onClick={closeDeleteList}
          >
            Cancel
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

function SearchField({ pathname }: { pathname: string }) {
  const router = useRouter();
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (pathname.startsWith("/search")) {
      setQuery(new URLSearchParams(window.location.search).get("q") ?? "");
      return;
    }
    setQuery("");
  }, [pathname]);

  function clearQuery() {
    setQuery("");
    if (pathname.startsWith("/search")) {
      router.push("/search");
    }
    queueMicrotask(() => {
      document.getElementById("task-search")?.focus();
    });
  }

  return (
    <form action="/search" className="flex-1">
      <label className="sr-only" htmlFor="task-search">
        Search tasks
      </label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
        <input
          id="task-search"
          name="q"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            if (event.defaultPrevented) return;
            if (
              [...document.querySelectorAll('[role="dialog"]')].some(
                (el) => el.getAttribute("aria-labelledby") !== "task-detail-title",
              )
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            if (query) {
              clearQuery();
              return;
            }
            event.currentTarget.blur();
            queueMicrotask(() => document.getElementById("content")?.focus());
          }}
          placeholder="Search tasks"
          className={`h-10 w-full rounded-full border border-line bg-surface pl-9 text-sm shadow-sm ${query ? "pr-16" : "pr-3"}`}
        />
        {query ? (
          <button
            type="button"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-xs text-muted hover:bg-sidebar"
            aria-label="Clear search"
            onClick={clearQuery}
          >
            Clear
          </button>
        ) : null}
      </div>
    </form>
  );
}

function SyncStatus({
  phase,
  count,
  disabled,
  onRetry,
}: {
  phase: "synced" | "pending" | "retrying" | "attention";
  count: number;
  disabled?: boolean;
  onRetry: () => void;
}) {
  const label = phase === "retrying" ? "Retrying" : phase === "attention" ? "Needs attention" : phase === "pending" ? `${count} pending` : "Synced";
  const ariaLabel = disabled
    ? phase === "synced"
      ? "Sync status: synced. You are offline."
      : phase === "attention"
        ? "Sync status: Needs attention. You are offline. Reconnect, then choose Keep mine or Keep server."
        : `Sync status: ${label}. You are offline. Reconnect to sync.`
    : phase === "synced"
      ? "Sync status: synced"
      : phase === "attention"
        ? "Sync status: Needs attention. Choose Keep mine or Keep server, or click for status."
        : `Sync status: ${label}. Click to retry.`;
  return (
    <button
      id="sync-status"
      className="inline rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-sidebar disabled:opacity-50"
      type="button"
      disabled={disabled}
      aria-live="polite"
      aria-busy={phase === "retrying" || phase === "pending"}
      aria-label={ariaLabel}
      onClick={onRetry}
    >
      {label}
    </button>
  );
}

function navItemActive(pathname: string, href: string) {
  if (href === "/tags") return pathname === "/tags" || pathname.startsWith("/tags/");
  return pathname === href;
}

function NavLink({
  href,
  label,
  collapsed,
  active,
  icon: Icon,
}: {
  href: string;
  label: string;
  collapsed: boolean;
  active: boolean;
  icon: typeof Inbox;
}) {
  return (
    <Link
      href={href}
      title={label}
      aria-label={collapsed ? label : undefined}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-2 rounded-xl px-2 py-2 text-sm hover:bg-surface ${active ? "bg-accent/10 font-medium text-accent" : "text-muted"}`}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      {collapsed ? null : label}
    </Link>
  );
}

function ListDot({ list }: { list: ListDto }) {
  const colors: Record<ListDto["color"], string> = {
    clay: "text-accent",
    sea: "text-[#2f6f6a]",
    plum: "text-[#6d4c7d]",
    moss: "text-[#4d7c0f]",
    gold: "text-[#a16207]",
    slate: "text-[#475569]",
    rose: "text-[#be123c]",
    sky: "text-[#0369a1]",
  };
  const icons: Record<ListIcon, typeof Inbox> = {
    inbox: Inbox,
    home: Home,
    briefcase: Briefcase,
    book: Book,
    heart: Heart,
    star: Star,
    flag: Flag,
    sun: Sun,
    moon: Moon,
    gift: Gift,
    music: Music,
    code: Code,
    plane: Plane,
  };
  const Icon = icons[list.icon] ?? Star;
  return <Icon className={`inline-block h-3.5 w-3.5 ${colors[list.color]}`} aria-hidden="true" />;
}

function isTextEntry(target: HTMLElement | null): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === "TEXTAREA") return true;
  if (target.tagName !== "INPUT") return false;
  const type = (target as HTMLInputElement).type;
  return type !== "checkbox" && type !== "radio" && type !== "button" && type !== "submit" && type !== "reset";
}
