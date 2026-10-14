"use client";

import { ApiError } from "@vela/api-client";
import { LIST_COLORS } from "@vela/shared";
import { Button, Input } from "@vela/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useOnline, useToast } from "@/components/providers";
import { api } from "@/lib/api";

export default function TagsPage() {
  const tags = useQuery({ queryKey: ["tags"], queryFn: () => api.tags() });
  const queryClient = useQueryClient();
  const toast = useToast();
  const online = useOnline();
  const [name, setName] = useState("");

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!online) {
      toast.push("You are offline. Reconnect to save changes.");
      return;
    }
    try {
      const color = LIST_COLORS[(tags.data?.length ?? 0) % LIST_COLORS.length] ?? "sea";
      await api.createTag({ name, color });
      setName("");
      await queryClient.invalidateQueries({ queryKey: ["tags"] });
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not create the tag.");
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="font-serif text-4xl">Tags</h1>
      <form className="mt-4 flex gap-2" onSubmit={(event) => void create(event)}>
        <Input aria-label="Tag name" value={name} onChange={(event) => setName(event.target.value)} placeholder="New tag" />
        <Button type="submit">Add</Button>
      </form>
      <ul className="mt-6 divide-y divide-line rounded-xl border border-line bg-surface">
        {(tags.data ?? []).map((tag) => (
          <li key={tag.id} className="flex items-center justify-between px-3 py-3">
            <Link href={`/tags/${tag.id}`}>{tag.name}</Link>
            <button
              className="text-sm text-danger"
              type="button"
              onClick={() =>
                void api.deleteTag(tag.id).then(() => queryClient.invalidateQueries({ queryKey: ["tags"] }))
              }
            >
              Delete
            </button>
          </li>
        ))}
        {tags.data && tags.data.length === 0 ? <li className="px-3 py-6 text-sm text-muted">No tags yet.</li> : null}
      </ul>
    </div>
  );
}
