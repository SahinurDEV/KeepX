"use client";

import { ApiError } from "@vela/api-client";
import { APP_VERSION } from "@vela/shared";
import { Button, Input } from "@vela/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { useOnline, useToast } from "@/components/providers";
import { api, appName } from "@/lib/api";

export default function SettingsPage() {
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  const archived = useQuery({ queryKey: ["tasks", { view: "archived" }], queryFn: () => api.listTasks({ view: "archived" }) });
  const queryClient = useQueryClient();
  const toast = useToast();
  const online = useOnline();
  const [name, setName] = useState("");
  const [timeZone, setTimeZone] = useState("UTC");
  const zones = typeof Intl !== "undefined" && "supportedValuesOf" in Intl ? Intl.supportedValuesOf("timeZone") : ["UTC"];

  useEffect(() => {
    if (!me.data) return;
    setName(me.data.name);
    setTimeZone(me.data.timeZone);
  }, [me.data]);

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    if (!online) return toast.push("You are offline. Reconnect to save changes.");
    try {
      await api.updateProfile({ name, timeZone });
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      toast.push("Profile saved.");
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not save the profile.");
    }
  }

  async function savePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!online) return toast.push("You are offline. Reconnect to save changes.");
    const form = new FormData(event.currentTarget);
    try {
      await api.changePassword({
        currentPassword: String(form.get("current") ?? ""),
        newPassword: String(form.get("next") ?? ""),
      });
      event.currentTarget.reset();
      toast.push("Password updated.");
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not change the password.");
    }
  }

  function setTheme(theme: "light" | "dark" | "system") {
    localStorage.setItem("vela-theme", theme);
    const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8 px-4 py-8">
      <div>
        <h1 className="font-serif text-4xl">Settings</h1>
        <p className="mt-2 text-sm text-muted">
          {appName()} {APP_VERSION}. In-app reminders are the only notification channel. Billing is not connected. Password recovery email is not configured.
        </p>
      </div>
      <form className="space-y-3" onSubmit={(event) => void saveProfile(event)}>
        <h2 className="text-lg font-medium">Profile</h2>
        <label className="block text-sm">
          Name
          <Input className="mt-1" value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="block text-sm">
          Time zone
          <select className="mt-1 h-10 w-full rounded-lg border border-line bg-surface px-2" value={timeZone} onChange={(event) => setTimeZone(event.target.value)}>
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit">Save profile</Button>
      </form>
      <form className="space-y-3" onSubmit={(event) => void savePassword(event)}>
        <h2 className="text-lg font-medium">Password</h2>
        <Input name="current" type="password" autoComplete="current-password" aria-label="Current password" required />
        <Input name="next" type="password" autoComplete="new-password" minLength={10} aria-label="New password" required />
        <Button type="submit" variant="secondary">
          Change password
        </Button>
      </form>
      <section>
        <h2 className="text-lg font-medium">Appearance</h2>
        <div className="mt-3 flex gap-2">
          {(["light", "dark", "system"] as const).map((theme) => (
            <Button key={theme} type="button" variant="secondary" onClick={() => setTheme(theme)}>
              {theme}
            </Button>
          ))}
        </div>
      </section>
      <section>
        <h2 className="text-lg font-medium">Archived tasks</h2>
        <ul className="mt-3 divide-y divide-line rounded-xl border border-line">
          {(archived.data?.tasks ?? []).map((task) => (
            <li key={task.id} className="flex items-center justify-between px-3 py-2 text-sm">
              {task.title}
              <button
                className="text-accent"
                type="button"
                onClick={() =>
                  void api.unarchiveTask(task.id).then(() => queryClient.invalidateQueries({ queryKey: ["tasks"] }))
                }
              >
                Unarchive
              </button>
            </li>
          ))}
          {archived.data && archived.data.tasks.length === 0 ? <li className="px-3 py-4 text-sm text-muted">No archived tasks.</li> : null}
        </ul>
      </section>
    </div>
  );
}
