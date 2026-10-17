"use client";

import { ApiError } from "@vela/api-client";
import { LIST_COLORS, type ListColor, type TagDto } from "@vela/shared";
import { Button, Input } from "@vela/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { useOnline, useToast } from "@/components/providers";
import { api } from "@/lib/api";
import { tagSwatch } from "@/lib/tag-color";

function isTextEntry(target: HTMLElement | null): target is HTMLElement {
  if (!target) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === "TEXTAREA") return true;
  if (target.tagName !== "INPUT") return false;
  const type = (target as HTMLInputElement).type;
  return type !== "checkbox" && type !== "radio" && type !== "button" && type !== "submit" && type !== "reset";
}

function canFocusTag(element: HTMLElement | null): element is HTMLElement {
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

function focusTagTargets(...ids: string[]) {
  queueMicrotask(() => {
    for (const id of ids) {
      const target = document.getElementById(id);
      if (!canFocusTag(target)) continue;
      target.focus();
      return;
    }
    document.getElementById("content")?.focus();
  });
}

export default function TagsPage() {
  const tags = useQuery({ queryKey: ["tags"], queryFn: () => api.tags() });
  const queryClient = useQueryClient();
  const toast = useToast();
  const online = useOnline();
  const [name, setName] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"]')) return;
      const target = event.target as HTMLElement | null;
      if (isTextEntry(target)) {
        target.blur();
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function create(event: FormEvent) {
    event.preventDefault();
    const focusTagName = () => focusTagTargets("tag-name");
    if (!online) {
      toast.push("You are offline. Reconnect to add a tag.");
      focusTagName();
      return;
    }
    const trimmed = name.trim();
    if (!trimmed) {
      toast.push("Choose a tag name.");
      focusTagName();
      return;
    }
    try {
      const color = LIST_COLORS[(tags.data?.length ?? 0) % LIST_COLORS.length] ?? "sea";
      const created = await api.createTag({ name: trimmed, color });
      setName("");
      await queryClient.invalidateQueries({ queryKey: ["tags"] });
      const createdId = created.id;
      toast.push("Tag created.", {
        label: "Undo",
        run: () => {
          if (!navigator.onLine) {
            toast.push("You are offline. Reconnect to delete that tag.");
            focusTagName();
            return;
          }
          void api
            .deleteTag(createdId)
            .then(() => queryClient.invalidateQueries({ queryKey: ["tags"] }))
            .then(() => {
              toast.push("Removed the tag.");
              focusTagName();
            })
            .catch((error: unknown) => {
              void queryClient.invalidateQueries({ queryKey: ["tags"] });
              toast.push(error instanceof ApiError ? error.message : "Could not delete the tag.");
              focusTagName();
            });
        },
      });
      focusTagName();
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not create the tag.");
      focusTagName();
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="font-serif text-4xl">Tags</h1>
      <p className="mt-2 text-sm text-muted">Rename a tag or change its color. Deleting a tag removes it from tasks. Undo brings the tag back and puts it on those tasks again, except tasks that are still in Trash.</p>
      {!online ? <p className="mt-2 text-sm text-muted">You are offline. Reconnect to add, rename, or delete a tag.</p> : null}
      <form className="mt-4 flex gap-2" onSubmit={(event) => void create(event)}>
        <Input id="tag-name" aria-label="Tag name" value={name} onChange={(event) => setName(event.target.value)} placeholder="New tag" autoFocus disabled={!online} />
        <Button type="submit" disabled={!online} aria-label="Add tag">
          Add
        </Button>
      </form>
      {tags.isError ? (
        <div className="mt-4 text-sm">
          <p>Tags could not be loaded.</p>
          <button className="mt-2 text-accent" type="button" aria-label="Tags could not be loaded. Try again" onClick={() => void tags.refetch()}>
            Try again
          </button>
        </div>
      ) : null}
      {tags.isLoading ? (
        <p className="mt-4 text-sm text-muted" role="status">
          Loading tags…
        </p>
      ) : null}
      {tags.data ? (
        <ul className="mt-6 divide-y divide-line rounded-xl border border-line bg-surface">
          {tags.data.map((tag) => (
            <TagRow
              key={tag.id}
              tag={tag}
              online={online}
              onSaved={() => queryClient.invalidateQueries({ queryKey: ["tags"] })}
              onError={(message) => toast.push(message)}
              onUnchanged={() => toast.push("That tag already has that name and color.")}
            />
          ))}
          {tags.data.length === 0 ? (
            <li className="px-3 py-6 text-sm text-muted" role="status">
              No tags yet.
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

function TagRow({
  tag,
  online,
  onSaved,
  onError,
  onUnchanged,
}: {
  tag: TagDto;
  online: boolean;
  onSaved: () => Promise<void> | void;
  onError: (message: string) => void;
  onUnchanged: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState(tag.name);
  const [color, setColor] = useState<ListColor>(tag.color);

  async function save(event: FormEvent) {
    event.preventDefault();
    const focusName = () => focusTagTargets(`tag-name-${tag.id}`, "tag-name");
    if (!online) {
      onError("You are offline. Reconnect to rename that tag.");
      focusName();
      return;
    }
    const previous = { name: tag.name, color: tag.color };
    const nextName = name.trim();
    if (nextName === previous.name && color === previous.color) {
      onUnchanged();
      focusName();
      return;
    }
    if (!nextName) {
      onError("Choose a tag name.");
      focusName();
      return;
    }
    try {
      await api.updateTag(tag.id, { name: nextName, color });
      await onSaved();
      toast.push("Tag saved.", {
        label: "Undo",
        run: () => {
          if (!navigator.onLine) {
            onError("You are offline. Reconnect to restore that tag.");
            focusName();
            return;
          }
          void api
            .updateTag(tag.id, { name: previous.name, color: previous.color })
            .then(async () => {
              setName(previous.name);
              setColor(previous.color);
              await onSaved();
              toast.push("Restored the tag.");
              focusName();
            })
            .catch((error: unknown) => {
              void onSaved();
              onError(error instanceof ApiError ? error.message : "Could not restore the tag.");
              focusName();
            });
        },
      });
    } catch (error) {
      onError(error instanceof ApiError ? error.message : "Could not save the tag.");
      focusName();
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-3">
          <Link className="flex min-w-0 flex-1 items-center gap-2 truncate text-sm" href={`/tags/${tag.id}`}>
        <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${tagSwatch[tag.color]}`} aria-hidden="true" />
        {tag.name}
      </Link>
      <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => void save(event)}>
        <Input
          id={`tag-name-${tag.id}`}
          aria-label={`Name for ${tag.name}`}
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={40}
          required
          disabled={!online}
        />
        <select
          aria-label={`Color for ${tag.name}`}
          className="h-10 rounded-lg border border-line bg-surface px-2 text-sm"
          value={color}
          onChange={(event) => setColor(event.target.value as ListColor)}
          disabled={!online}
        >
          {LIST_COLORS.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <Button type="submit" variant="secondary" disabled={!online} aria-label={`Save ${tag.name}`}>
          Save
        </Button>
        <button
          className="text-sm text-danger disabled:opacity-50"
          type="button"
          aria-label={`Delete ${tag.name}`}
          disabled={!online}
          onClick={() => {
            const focusNewTag = () => focusTagTargets("tag-name");
            if (!online) {
              onError("You are offline. Reconnect to delete that tag.");
              focusNewTag();
              return;
            }
            const previous = { name: tag.name, color: tag.color };
            void (async () => {
              try {
                const tagged = new Set<string>();
                for (const view of ["all", "completed", "archived", "tag"] as const) {
                  const page = await api.listTasks({ view, tagId: tag.id });
                  for (const task of page.tasks) tagged.add(task.id);
                }
                const taskIds = [...tagged];
                await api.deleteTag(tag.id);
                await onSaved();
                await queryClient.invalidateQueries({ queryKey: ["tasks"] });
                focusNewTag();
                toast.push("Tag deleted.", {
                  label: "Undo",
                  run: () => {
                    if (!navigator.onLine) {
                      onError("You are offline. Reconnect to restore that tag.");
                      focusNewTag();
                      return;
                    }
                    void (async () => {
                      try {
                        const created = await api.createTag({ name: previous.name, color: previous.color });
                        for (let index = 0; index < taskIds.length; index += 100) {
                          const chunk = taskIds.slice(index, index + 100);
                          if (chunk.length === 0) continue;
                          await api.batchTasks({ ids: chunk, action: "tag", tagId: created.id, tagMode: "add" });
                        }
                        await onSaved();
                        await queryClient.invalidateQueries({ queryKey: ["tasks"] });
                        toast.push(
                          taskIds.length === 0
                            ? "Restored the tag."
                            : taskIds.length === 1
                              ? "Restored the tag on 1 task."
                              : `Restored the tag on ${taskIds.length} tasks.`,
                        );
                        focusNewTag();
                      } catch (error: unknown) {
                        void onSaved();
                        void queryClient.invalidateQueries({ queryKey: ["tasks"] });
                        onError(error instanceof ApiError ? error.message : "Could not restore the tag.");
                        focusNewTag();
                      }
                    })();
                  },
                });
              } catch (error: unknown) {
                onError(error instanceof ApiError ? error.message : "Could not delete the tag.");
                focusNewTag();
              }
            })();
          }}
        >
          Delete
        </button>
      </form>
    </li>
  );
}
