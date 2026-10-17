"use client";

import { ApiError } from "@vela/api-client";
import { APP_VERSION } from "@vela/shared";
import { Button, Input } from "@vela/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useOnline, useToast } from "@/components/providers";
import { api, appName } from "@/lib/api";
import { subscribeBrowser } from "@/lib/push";

export default function SettingsPage() {
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  const meta = useQuery({ queryKey: ["meta"], queryFn: () => api.meta() });
  const [archivedUndated, setArchivedUndated] = useState(false);
  const archived = useQuery({
    queryKey: ["tasks", { view: "archived", due: archivedUndated ? "none" : undefined }],
    queryFn: () => api.listTasks({ view: "archived", due: archivedUndated ? "none" : undefined }),
  });
  const queryClient = useQueryClient();
  const toast = useToast();
  const online = useOnline();
  const archivedBusy = useRef(false);
  const archivedSelectAllRef = useRef<HTMLButtonElement | null>(null);
  const archivedFilterAnchorRef = useRef<HTMLButtonElement | null>(null);
  const tokens = useQuery({ queryKey: ["tokens"], queryFn: () => api.accessTokens() });
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: () => api.sessions() });
  const devices = useQuery({ queryKey: ["devices"], queryFn: () => api.devices() });
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [freshTokenId, setFreshTokenId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [timeZone, setTimeZone] = useState("UTC");
  const [emailReminders, setEmailReminders] = useState(false);
  const [pushReminders, setPushReminders] = useState(false);
  const [billingReturn, setBillingReturn] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [archivedChecked, setArchivedChecked] = useState<string[]>([]);
  const [profileDirty, setProfileDirty] = useState(false);
  const [appearanceTheme, setAppearanceTheme] = useState<"light" | "dark" | "system">("system");
  const zones = typeof Intl !== "undefined" && "supportedValuesOf" in Intl ? Intl.supportedValuesOf("timeZone") : ["UTC"];

  function clearArchivedSelection() {
    setArchivedChecked([]);
    queueMicrotask(() => (archivedSelectAllRef.current ?? document.getElementById("settings-heading"))?.focus());
  }

  function clearArchivedFilters() {
    setArchivedUndated(false);
    queueMicrotask(() => (archivedFilterAnchorRef.current ?? document.getElementById("settings-heading"))?.focus());
  }

  function focusSettingsControl(...ids: string[]) {
    queueMicrotask(() => {
      for (const id of ids) {
        const control = document.getElementById(id);
        if (!control) continue;
        if (
          (control instanceof HTMLInputElement ||
            control instanceof HTMLButtonElement ||
            control instanceof HTMLSelectElement ||
            control instanceof HTMLTextAreaElement) &&
          control.disabled
        ) {
          continue;
        }
        if (control.getAttribute("aria-disabled") === "true") continue;
        control.focus();
        return;
      }
      document.getElementById("settings-heading")?.focus();
    });
  }

  function dismissFreshToken() {
    setFreshToken(null);
    setFreshTokenId(null);
    focusSettingsControl("create-token");
  }

  function dismissBillingReturn() {
    setBillingReturn(false);
    const url = new URL(window.location.href);
    if (url.searchParams.has("billing")) {
      url.searchParams.delete("billing");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    }
    queueMicrotask(() => document.getElementById("settings-heading")?.focus());
  }

  useEffect(() => {
    setBillingReturn(new URLSearchParams(window.location.search).get("billing") === "return");
  }, []);

  useEffect(() => {
    const stored = localStorage.getItem("vela-theme");
    if (stored === "light" || stored === "dark" || stored === "system") setAppearanceTheme(stored);
  }, []);

  useEffect(() => {
    if (!me.data || profileDirty) return;
    setName(me.data.name);
    setTimeZone(me.data.timeZone);
    setEmailReminders(me.data.emailReminders);
    setPushReminders(me.data.pushReminders);
  }, [me.data?.name, me.data?.timeZone, me.data?.emailReminders, me.data?.pushReminders, profileDirty]);

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
      if (freshToken) {
        event.preventDefault();
        dismissFreshToken();
        return;
      }
      if (billingReturn) {
        event.preventDefault();
        dismissBillingReturn();
        return;
      }
      if (archivedChecked.length > 0) {
        event.preventDefault();
        clearArchivedSelection();
        return;
      }
      if (archivedUndated) {
        event.preventDefault();
        clearArchivedFilters();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [freshToken, billingReturn, archivedChecked.length, archivedUndated]);

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    const focusProfile = () => focusSettingsControl("profile-name");
    if (!online) {
      toast.push("You are offline. Reconnect to save the profile.");
      focusProfile();
      return;
    }
    if (me.isError || !me.data) {
      toast.push("Profile could not be loaded. Try again first.");
      focusProfile();
      return;
    }
    if (
      name.trim() === me.data.name &&
      timeZone === me.data.timeZone &&
      emailReminders === me.data.emailReminders &&
      pushReminders === me.data.pushReminders
    ) {
      toast.push("That profile already has those settings.");
      focusProfile();
      return;
    }
    const previous = me.data
      ? {
          name: me.data.name,
          timeZone: me.data.timeZone,
          emailReminders: me.data.emailReminders,
          pushReminders: me.data.pushReminders,
        }
      : null;
    try {
      await api.updateProfile({ name, timeZone, emailReminders, pushReminders });
      setProfileDirty(false);
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      if (!previous) {
        toast.push("Profile saved.");
        focusProfile();
        return;
      }
      toast.push("Profile saved.", {
        label: "Undo",
        run: () => {
          if (!navigator.onLine) {
            toast.push("You are offline. Reconnect to restore the profile.");
            focusProfile();
            return;
          }
          void api
            .updateProfile(previous)
            .then(() => {
              setName(previous.name);
              setTimeZone(previous.timeZone);
              setEmailReminders(previous.emailReminders);
              setPushReminders(previous.pushReminders);
              setProfileDirty(false);
              return queryClient.invalidateQueries({ queryKey: ["me"] });
            })
            .then(() => {
              toast.push("Restored the profile.");
              focusProfile();
            })
            .catch((error: unknown) => {
              void queryClient.invalidateQueries({ queryKey: ["me"] });
              toast.push(error instanceof ApiError ? error.message : "Could not restore the profile.");
              focusProfile();
            });
        },
      });
      focusProfile();
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not save the profile.");
      focusProfile();
    }
  }

  async function savePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const focusPassword = () => focusSettingsControl("current-password");
    if (!online) {
      toast.push("You are offline. Reconnect to change the password.");
      focusPassword();
      return;
    }
    const form = new FormData(event.currentTarget);
    try {
      await api.changePassword({
        currentPassword: String(form.get("current") ?? ""),
        newPassword: String(form.get("next") ?? ""),
      });
      event.currentTarget.reset();
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      await queryClient.invalidateQueries({ queryKey: ["tokens"] });
      toast.push("Password updated. Other browsers and app tokens were signed out.", {
        label: "Undo",
        run: () => {
          if (!navigator.onLine) {
            toast.push("You are offline. Reconnect to restore the previous password.");
            focusPassword();
            return;
          }
          void api
            .restorePassword()
            .then(() => {
              toast.push("Previous password restored.");
              focusPassword();
            })
            .catch((error: unknown) => {
              toast.push(error instanceof ApiError ? error.message : "Could not restore the previous password.");
              focusPassword();
            });
        },
      });
      focusPassword();
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not change the password.");
      focusPassword();
    }
  }

  async function removeAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!online) {
      toast.push("You are offline. Reconnect to delete the account.");
      focusSettingsControl("delete-password");
      return;
    }
    if (!confirmDelete) {
      toast.push("Confirm that this cannot be undone.");
      focusSettingsControl("confirm-delete");
      return;
    }
    const form = new FormData(event.currentTarget);
    try {
      await api.deleteAccount({ password: String(form.get("password") ?? "") });
      queryClient.clear();
      window.location.assign("/login");
    } catch (error) {
      toast.push(error instanceof ApiError ? error.message : "Could not delete the account.");
      focusSettingsControl("delete-password");
    }
  }

  function applyTheme(theme: "light" | "dark" | "system") {
    localStorage.setItem("vela-theme", theme);
    setAppearanceTheme(theme);
    const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  }

  function setTheme(theme: "light" | "dark" | "system") {
    const focusAppearance = (value: "light" | "dark" | "system") =>
      queueMicrotask(() => document.getElementById(`appearance-${value}`)?.focus());
    const stored = localStorage.getItem("vela-theme");
    const previous = stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
    if (previous === theme) {
      toast.push("That appearance is already selected.");
      focusAppearance(theme);
      return;
    }
    applyTheme(theme);
    toast.push(`Appearance set to ${theme}.`, {
      label: "Undo",
      run: () => {
        applyTheme(previous);
        toast.push(`Appearance set to ${previous}.`);
        focusAppearance(previous);
      },
    });
    focusAppearance(theme);
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8 px-4 py-8">
      <div>
        <h1 id="settings-heading" className="font-serif text-4xl" tabIndex={-1}>
          Settings
        </h1>
        <p className="mt-2 text-sm text-muted">
          {appName()} {APP_VERSION}. Reminders appear in the open app. The Windows or Linux desktop app can also raise a system notification when the OS supports it.{" "}
          {me.isLoading ? "Loading your plan…" : me.data?.plan === "plus" ? "Plus." : "Personal."}{" "}
          {meta.isLoading
            ? "Loading server options…"
            : meta.data
              ? `${meta.data.billing ? "Checkout can start from Pricing." : "Billing is not connected. No payment is collected."} ${
                  meta.data.emailRecovery ? "Password recovery email is configured." : "Password recovery email is not configured."
                }`
              : meta.isError
                ? "Server options could not be loaded."
                : ""}{" "}
          {billingReturn ? (
            <>
              This page does not change your plan. The plan changes only after a signed billing notice.{" "}
              <button className="text-accent" type="button" aria-label="Dismiss billing return notice" onClick={dismissBillingReturn}>
                Dismiss
              </button>
            </>
          ) : null}
        </p>
      </div>
      <form className="space-y-3" onSubmit={(event) => void saveProfile(event)}>
        <h2 className="text-lg font-medium">Profile</h2>
        <LoadRetry error={me.isError} label="Profile could not be loaded." onRetry={() => void me.refetch()} />
        <LoadRetry error={meta.isError} label="Server options could not be loaded." onRetry={() => void meta.refetch()} />
        {me.isLoading ? (
          <p className="text-sm text-muted" role="status">
            Loading profile…
          </p>
        ) : null}
        {meta.isLoading ? (
          <p className="text-sm text-muted" role="status">
            Loading server options…
          </p>
        ) : null}
        <label className="block text-sm">
          Name
          <Input
            id="profile-name"
            className="mt-1"
            value={name}
            onChange={(event) => {
              setProfileDirty(true);
              setName(event.target.value);
            }}
            disabled={!online || me.isError || me.isLoading || !me.data}
          />
        </label>
        <label className="block text-sm">
          Time zone
          <select
            className="mt-1 h-10 w-full rounded-lg border border-line bg-surface px-2"
            value={timeZone}
            onChange={(event) => {
              setProfileDirty(true);
              setTimeZone(event.target.value);
            }}
            disabled={!online || me.isError || me.isLoading || !me.data}
          >
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            className="mt-1"
            type="checkbox"
            checked={emailReminders}
            onChange={(event) => {
              setProfileDirty(true);
              setEmailReminders(event.target.checked);
            }}
            disabled={!online || me.isError || me.isLoading || !me.data}
          />
          <span>
            Email me when a reminder is due.
            <span className="mt-1 block text-xs text-muted">
              {meta.isLoading
                ? "Loading mail options…"
                : meta.data?.notificationChannels.includes("email")
                  ? "Mail is configured. The message goes out only while the API is running, and only if the reminder is less than 15 minutes late."
                  : "Mail is not configured, so this choice is saved and no reminder email is sent."}
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            className="mt-1"
            type="checkbox"
            checked={pushReminders}
            onChange={(event) => {
              setProfileDirty(true);
              setPushReminders(event.target.checked);
            }}
            disabled={!online || me.isError || me.isLoading || !me.data}
          />
          <span>
            Send a push notification when a reminder is due.
            <span className="mt-1 block text-xs text-muted">
              {meta.isLoading
                ? "Loading push options…"
                : meta.data?.notificationChannels.includes("web_push")
                  ? "This server can notify a browser that has allowed notifications. A reminder more than 15 minutes late is not sent."
                  : "Browser push is not configured, so this choice is saved and no browser notification is sent."}{" "}
              {!meta.isLoading && meta.data?.notificationChannels.includes("expo_push")
                ? "Phone push is configured for a device that has registered an Expo token."
                : !meta.isLoading
                  ? "The Android package does not register for phone push, and no Expo access token is configured."
                  : ""}
            </span>
          </span>
        </label>
        <Button type="submit" disabled={!online || me.isError || me.isLoading || !me.data || !profileDirty}>
          Save profile
        </Button>
      </form>
      <section className="space-y-3">
        <h2 id="this-browser" className="text-lg font-medium" tabIndex={-1}>
          This browser
        </h2>
        <p className="text-sm text-muted">Allow notifications here. That turns push reminders on for this account. Undo removes that device. Removing a device can be undone. KeepX does not show the subscription again.</p>
        <LoadRetry error={devices.isError} label="Devices could not be loaded." onRetry={() => void devices.refetch()} />
        {devices.isLoading ? (
          <p className="text-sm text-muted" role="status">
            Loading devices…
          </p>
        ) : null}
        {meta.data?.webPushPublicKey ? (
          <Button
            id="allow-notifications"
            type="button"
            variant="secondary"
            aria-label="Allow notifications in this browser"
            disabled={!online}
            onClick={() => {
              const focusAllow = () => focusSettingsControl("allow-notifications");
              const publicKey = meta.data?.webPushPublicKey;
              if (!publicKey) return;
              if (!online) {
                toast.push("You are offline. Reconnect to allow notifications.");
                focusAllow();
                return;
              }
              void subscribeBrowser(publicKey)
                .then(async (token) => {
                  const device = await api.registerDevice({ platform: "web", token });
                  await api.updateProfile({ pushReminders: true });
                  setPushReminders(true);
                  setProfileDirty(
                    Boolean(
                      me.data &&
                        (name.trim() !== me.data.name ||
                          timeZone !== me.data.timeZone ||
                          emailReminders !== me.data.emailReminders),
                    ),
                  );
                  await queryClient.invalidateQueries({ queryKey: ["devices"] });
                  await queryClient.invalidateQueries({ queryKey: ["me"] });
                  const deviceId = device.id;
                  toast.push("This browser will be notified when a reminder is due.", {
                    label: "Undo",
                    run: () => {
                      if (!navigator.onLine) {
                        toast.push("You are offline. Reconnect to turn off notifications in this browser.");
                        focusAllow();
                        return;
                      }
                      void api
                        .deleteDevice(deviceId)
                        .then(async () => {
                          await queryClient.invalidateQueries({ queryKey: ["devices"] });
                          toast.push("Notifications turned off in this browser.");
                          focusAllow();
                        })
                        .catch((error: unknown) => {
                          toast.push(
                            error instanceof ApiError
                              ? error.message
                              : "Could not turn off notifications in this browser.",
                          );
                          focusAllow();
                        });
                    },
                  });
                  focusAllow();
                })
                .catch(async (error: unknown) => {
                  await queryClient.invalidateQueries({ queryKey: ["devices"] });
                  await queryClient.invalidateQueries({ queryKey: ["me"] });
                  toast.push(
                    error instanceof ApiError
                      ? error.message
                      : error instanceof Error
                        ? error.message
                        : "Could not allow notifications.",
                  );
                  focusAllow();
                });
            }}
          >
            Allow notifications in this browser
          </Button>
        ) : (
          <p className="text-sm text-muted">Browser push is not configured on this server.</p>
        )}
        {devices.data ? (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {devices.data.map((device) => (
            <li key={device.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span className="min-w-0">
                <span className="block">{device.platform === "web" ? "Browser" : device.platform === "android" ? "Android" : "iOS"}</span>
                <span className="block text-xs text-muted">Added {new Date(device.createdAt).toLocaleString()}</span>
              </span>
              <Button
                id={`remove-device-${device.id}`}
                type="button"
                variant="ghost"
                aria-label={`Remove ${device.platform === "web" ? "browser" : device.platform} added ${new Date(device.createdAt).toLocaleString()}`}
                disabled={!online}
                onClick={() => {
                  const deviceId = device.id;
                  const focusDevice = () =>
                    focusSettingsControl(`remove-device-${deviceId}`, "this-browser");
                  if (!online) {
                    toast.push("You are offline. Reconnect to remove that device.");
                    focusDevice();
                    return;
                  }
                  void api
                    .deleteDevice(deviceId)
                    .then(async (removed) => {
                      await queryClient.invalidateQueries({ queryKey: ["devices"] });
                      toast.push("Device removed.", {
                        label: "Undo",
                        run: () => {
                          if (!navigator.onLine) {
                            toast.push("You are offline. Reconnect to restore that device.");
                            focusDevice();
                            return;
                          }
                          void api
                            .registerDevice({ platform: removed.platform, token: removed.token })
                            .then(async () => {
                              await queryClient.invalidateQueries({ queryKey: ["devices"] });
                              toast.push("Device restored.");
                              focusDevice();
                            })
                            .catch((error: unknown) => {
                              toast.push(error instanceof ApiError ? error.message : "Could not restore that device.");
                              focusDevice();
                            });
                        },
                      });
                      focusDevice();
                    })
                    .catch((error: unknown) => {
                      toast.push(error instanceof ApiError ? error.message : "Could not remove that device.");
                      focusDevice();
                    });
                }}
              >
                Remove
              </Button>
            </li>
          ))}
          {devices.data.length === 0 ? <li className="px-3 py-4 text-sm text-muted">No devices yet.</li> : null}
        </ul>
        ) : null}
      </section>
      <form className="space-y-3" onSubmit={(event) => void savePassword(event)}>
        <h2 className="text-lg font-medium">Password</h2>
        {!online ? <p className="text-sm text-muted">You are offline. Reconnect to change the password.</p> : null}
        <Input id="current-password" name="current" type="password" autoComplete="current-password" aria-label="Current password" required disabled={!online} />
        <Input id="new-password" name="next" type="password" autoComplete="new-password" minLength={10} aria-label="New password" required disabled={!online} />
        <Button type="submit" variant="secondary" disabled={!online}>
          Change password
        </Button>
      </form>
      <section className="space-y-3">
        <h2 id="signed-in-browsers" className="text-lg font-medium" tabIndex={-1}>
          Signed-in browsers
        </h2>
        <p className="text-sm text-muted">
          These browsers are signed in with your password. Signing one out does not revoke app tokens. The session secret is not shown.
        </p>
        <LoadRetry error={sessions.isError} label="Signed-in browsers could not be loaded." onRetry={() => void sessions.refetch()} />
        {sessions.isLoading ? (
          <p className="text-sm text-muted" role="status">
            Loading signed-in browsers…
          </p>
        ) : null}
        {sessions.data ? (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {sessions.data.map((session) => (
              <li key={session.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-3 text-sm">
                <span>
                  <span className="font-medium">{session.current ? "This browser" : "Another browser"}</span>
                  <span className="mt-1 block text-xs text-muted">
                    Signed in {new Date(session.createdAt).toLocaleString()}
                    {session.userAgent ? ` · ${session.userAgent}` : ""}
                  </span>
                </span>
                <Button
                  id={`sign-out-session-${session.id}`}
                  type="button"
                  size="sm"
                  variant="secondary"
                  aria-label={`Sign out ${session.current ? "This browser" : "Another browser"} signed in ${new Date(session.createdAt).toLocaleString()}`}
                  disabled={!online}
                  onClick={() => {
                    const sessionId = session.id;
                    const focusSessions = () =>
                      focusSettingsControl(`sign-out-session-${sessionId}`, "signed-in-browsers");
                    if (!online) {
                      toast.push("You are offline. Reconnect to sign that browser out.");
                      focusSessions();
                      return;
                    }
                    const wasCurrent = session.current;
                    void api
                      .revokeSession(sessionId)
                      .then(async () => {
                        if (wasCurrent) {
                          queryClient.clear();
                          window.location.assign("/login");
                          return;
                        }
                        await queryClient.invalidateQueries({ queryKey: ["sessions"] });
                        toast.push("Signed that browser out.", {
                          label: "Undo",
                          run: () => {
                            if (!navigator.onLine) {
                              toast.push("You are offline. Reconnect to sign that browser back in.");
                              focusSessions();
                              return;
                            }
                            void api
                              .restoreSession(sessionId)
                              .then(async () => {
                                await queryClient.invalidateQueries({ queryKey: ["sessions"] });
                                toast.push("That browser is signed in again.");
                                focusSessions();
                              })
                              .catch((error: unknown) => {
                                void queryClient.invalidateQueries({ queryKey: ["sessions"] });
                                toast.push(error instanceof ApiError ? error.message : "Could not restore that browser.");
                                focusSessions();
                              });
                          },
                        });
                        focusSessions();
                      })
                      .catch((error: unknown) => {
                        toast.push(error instanceof ApiError ? error.message : "Could not sign that browser out.");
                        focusSessions();
                      });
                  }}
                >
                  Sign out
                </Button>
              </li>
            ))}
            {sessions.data.length === 0 ? <li className="px-3 py-4 text-sm text-muted">No browsers are signed in.</li> : null}
          </ul>
        ) : null}
      </section>
      <section className="space-y-3">
        <h2 className="text-lg font-medium">App tokens</h2>
        <p className="text-sm text-muted">
          Chrome, Edge, Firefox, and the Gmail add-on send a token instead of the browser session. Copy it now. KeepX does not show it again. Creating a token can be undone. Revoking one can be undone too.
        </p>
        <LoadRetry error={tokens.isError} label="App tokens could not be loaded." onRetry={() => void tokens.refetch()} />
        {!online ? <p className="text-sm text-muted">You are offline. Reconnect to create a token.</p> : null}
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const focusCreate = () => focusSettingsControl("create-token");
            if (!online) {
              toast.push("You are offline. Reconnect to create a token.");
              focusSettingsControl("token-name");
              return;
            }
            const form = event.currentTarget;
            const tokenName = String(new FormData(form).get("tokenName") ?? "").trim();
            if (!tokenName) {
              toast.push("Choose a token name.");
              focusSettingsControl("token-name");
              return;
            }
            void api
              .createAccessToken({ name: tokenName })
              .then(async (created) => {
                setFreshToken(created.token);
                setFreshTokenId(created.id);
                form.reset();
                await queryClient.invalidateQueries({ queryKey: ["tokens"] });
                const createdId = created.id;
                toast.push("Token created. Copy it now.", {
                  label: "Undo",
                  run: () => {
                    if (!navigator.onLine) {
                      toast.push("You are offline. Reconnect to revoke that token.");
                      focusCreate();
                      return;
                    }
                    void api
                      .deleteAccessToken(createdId)
                      .then(() => {
                        setFreshToken(null);
                        setFreshTokenId(null);
                        toast.push("Token revoked.");
                        return queryClient.invalidateQueries({ queryKey: ["tokens"] });
                      })
                      .then(() => focusCreate())
                      .catch((error: unknown) => {
                        toast.push(error instanceof ApiError ? error.message : "Could not revoke that token.");
                        focusCreate();
                      });
                  },
                });
                queueMicrotask(() => {
                  const dismiss = document.getElementById("dismiss-fresh-token");
                  if (dismiss) dismiss.focus();
                  else requestAnimationFrame(() => document.getElementById("dismiss-fresh-token")?.focus());
                });
              })
              .catch((error: unknown) => {
                toast.push(error instanceof ApiError ? error.message : "Could not create a token.");
                focusSettingsControl("token-name");
              });
          }}
        >
          <Input id="token-name" name="tokenName" aria-label="Token name" placeholder="Chrome extension" required maxLength={40} disabled={!online} />
          <Button id="create-token" type="submit" disabled={!online}>
            Create token
          </Button>
        </form>
        {freshToken ? (
          <div className="space-y-2 rounded-xl border border-line bg-surface p-3">
            <p className="break-all font-mono text-sm">{freshToken}</p>
            <button
              id="dismiss-fresh-token"
              className="text-sm text-accent"
              type="button"
              aria-label="Dismiss new token"
              onClick={dismissFreshToken}
            >
              Dismiss
            </button>
          </div>
        ) : null}
        {tokens.isLoading ? (
          <p className="text-sm text-muted" role="status">
            Loading app tokens…
          </p>
        ) : null}
        {tokens.data ? (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {tokens.data.map((token) => (
              <li key={token.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="block truncate">{token.name}</span>
                  <span className="block text-xs text-muted">Created {new Date(token.createdAt).toLocaleString()}</span>
                </span>
                <button
                  id={`revoke-token-${token.id}`}
                  className="text-accent disabled:opacity-50"
                  type="button"
                  aria-label={`Revoke ${token.name}`}
                  disabled={!online}
                  onClick={() => {
                    const tokenId = token.id;
                    const focusCreate = () => focusSettingsControl("create-token");
                    const focusRevoke = () => focusSettingsControl(`revoke-token-${tokenId}`);
                    if (!online) {
                      toast.push("You are offline. Reconnect to revoke that token.");
                      focusRevoke();
                      return;
                    }
                    void api
                      .deleteAccessToken(tokenId)
                      .then(async () => {
                        if (tokenId === freshTokenId) {
                          setFreshToken(null);
                          setFreshTokenId(null);
                        }
                        await queryClient.invalidateQueries({ queryKey: ["tokens"] });
                        toast.push("Token revoked.", {
                          label: "Undo",
                          run: () => {
                            if (!navigator.onLine) {
                              toast.push("You are offline. Reconnect to restore that token.");
                              focusCreate();
                              return;
                            }
                            void api
                              .restoreAccessToken(tokenId)
                              .then(async () => {
                                await queryClient.invalidateQueries({ queryKey: ["tokens"] });
                                toast.push("Token restored.");
                                focusRevoke();
                              })
                              .catch((error: unknown) => {
                                void queryClient.invalidateQueries({ queryKey: ["tokens"] });
                                toast.push(error instanceof ApiError ? error.message : "Could not restore that token.");
                                focusCreate();
                              });
                          },
                        });
                        focusCreate();
                      })
                      .catch((error: unknown) => {
                        toast.push(error instanceof ApiError ? error.message : "Could not revoke that token.");
                        focusRevoke();
                      });
                  }}
                >
                  Revoke
                </button>
              </li>
            ))}
            {tokens.data.length === 0 ? <li className="px-3 py-4 text-sm text-muted">No tokens yet.</li> : null}
          </ul>
        ) : null}
      </section>
      <section>
        <h2 className="text-lg font-medium">Appearance</h2>
        <p className="mt-2 text-sm text-muted">Choose light, dark, or system. Undo restores the previous choice. Choosing the one already in use leaves it as it is.</p>
        <div className="mt-3 flex gap-2">
          {(["light", "dark", "system"] as const).map((theme) => (
            <Button
              id={`appearance-${theme}`}
              key={theme}
              type="button"
              variant="secondary"
              aria-pressed={appearanceTheme === theme}
              onClick={() => setTheme(theme)}
            >
              {theme}
            </Button>
          ))}
        </div>
      </section>
      <section>
        <h2 className="text-lg font-medium">Archived tasks</h2>
        <p className="mt-2 text-sm text-muted">A subtask says which task it belongs to.</p>
        <LoadRetry error={archived.isError} label="Archived tasks could not be loaded." onRetry={() => void archived.refetch()} />
        <div className="mt-3 flex flex-wrap gap-2 text-sm">
          <button
            ref={archivedFilterAnchorRef}
            type="button"
            aria-pressed={archivedUndated}
            aria-label="No date archived"
            className={`rounded-full px-3 py-1 ${archivedUndated ? "bg-accent text-accent-ink" : "bg-sidebar"}`}
            onClick={() => setArchivedUndated((value) => !value)}
          >
            No date
          </button>
          {archivedUndated ? (
            <button type="button" className="rounded-full px-3 py-1 text-accent" aria-label="Clear archived filters" onClick={clearArchivedFilters}>
              Clear filters
            </button>
          ) : null}
        </div>
        <div className="mt-3 flex flex-wrap gap-3">
          {(archived.data?.tasks ?? []).length > 0 ? (
            <button
              ref={archivedSelectAllRef}
              className="text-sm text-accent"
              type="button"
              aria-label="Select all archived"
              onClick={() => setArchivedChecked((archived.data?.tasks ?? []).map((task) => task.id))}
            >
              Select all
            </button>
          ) : null}
          {archivedChecked.length > 0 ? (
            <button className="text-sm text-accent" type="button" aria-label="Clear archived selection" onClick={clearArchivedSelection}>
              Clear selection
            </button>
          ) : null}
        </div>
        {archivedChecked.length > 0 ? (
          <Button
            id="unarchive-selected"
            className="mt-3"
            type="button"
            size="sm"
            variant="secondary"
            disabled={!online}
            onClick={() => {
              const focusUnarchive = () =>
                focusSettingsControl("unarchive-selected", "this-browser");
              if (!online) {
                toast.push("You are offline. Reconnect to unarchive.");
                focusUnarchive();
                return;
              }
              if (archivedBusy.current) return;
              const rows = archived.data?.tasks ?? [];
              const ids = archivedChecked.filter((id) => rows.some((task) => task.id === id));
              if (ids.length === 0) return;
              const selected = new Set(ids);
              const roots = rows.filter((task) => ids.includes(task.id) && (!task.parentId || !selected.has(task.parentId)));
              archivedBusy.current = true;
              void api
                .batchTasks({ ids, action: "unarchive" })
                .then((result) => {
                  clearArchivedSelection();
                  const changedTasks = result.tasks.filter((task) => {
                    const before = roots.find((row) => row.id === task.id);
                    return Boolean(before && before.status === "archived" && task.status !== "archived");
                  });
                  const changed = changedTasks.length;
                  const unchanged = result.tasks.length - changed;
                  const selectedSubtasks = ids.some((id) => {
                    const row = rows.find((task) => task.id === id);
                    return Boolean(row?.parentId && changedTasks.some((task) => task.id === row.parentId));
                  });
                  const main =
                    changed === 0
                      ? unchanged === 1
                        ? "That task is already open."
                        : "Those tasks are already open."
                      : changed === 1
                        ? "Unarchived 1 task."
                        : `Unarchived ${changed} tasks.`;
                  const rest =
                    changed === 0 || unchanged === 0
                      ? ""
                      : unchanged === 1
                        ? " 1 was already open."
                        : ` ${unchanged} were already open.`;
                  const withSubtasks =
                    changed === 0
                      ? ""
                      : selectedSubtasks
                        ? changed === 1
                          ? " Its selected subtasks went with it."
                          : " Selected subtasks went with them."
                        : "";
                  if (changed === 0) {
                    toast.push(`${main}${rest}${withSubtasks}`);
                    focusUnarchive();
                    return queryClient.invalidateQueries({ queryKey: ["tasks"] });
                  }
                  const undoIds = changedTasks.map((task) => task.id);
                  toast.push(`${main}${rest}${withSubtasks}`, {
                    label: "Undo",
                    run: () => {
                      if (!navigator.onLine) {
                        toast.push("You are offline. Reconnect to archive the selection.");
                        focusUnarchive();
                        return;
                      }
                      void api
                        .batchTasks({ ids: undoIds, action: "archive" })
                        .then(async (restored) => {
                          const brought = restored.tasks.filter((task) => task.status === "archived").length;
                          toast.push(
                            brought === 0
                              ? "Those tasks are already archived."
                              : brought === 1
                                ? "Archived 1 task."
                                : `Archived ${brought} tasks.`,
                          );
                          focusUnarchive();
                          await queryClient.invalidateQueries({ queryKey: ["tasks"] });
                        })
                        .catch((error: unknown) => {
                          void queryClient.invalidateQueries({ queryKey: ["tasks"] });
                          toast.push(error instanceof ApiError ? error.message : "Could not archive the selection.");
                          focusUnarchive();
                        });
                    },
                  });
                  focusUnarchive();
                  return queryClient.invalidateQueries({ queryKey: ["tasks"] });
                })
                .catch((error: unknown) => {
                  toast.push(error instanceof ApiError ? error.message : "Could not unarchive the selection.");
                  focusUnarchive();
                })
                .finally(() => {
                  archivedBusy.current = false;
                });
            }}
          >
            Unarchive selected
          </Button>
        ) : null}
        {!online ? <p className="mt-2 text-sm text-muted">You are offline. Reconnect to unarchive.</p> : null}
        {archived.isLoading ? (
          <p className="mt-3 text-sm text-muted" role="status">
            Loading archived tasks…
          </p>
        ) : null}
        {archived.data ? (
          <ul className="mt-3 divide-y divide-line rounded-xl border border-line">
            {archived.data.tasks.map((task) => (
              <li key={task.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <label className="flex min-w-0 items-center gap-2">
                  <input
                    type="checkbox"
                    aria-label={`Select ${task.title}`}
                    checked={archivedChecked.includes(task.id)}
                    onChange={() =>
                      setArchivedChecked((current) => (current.includes(task.id) ? current.filter((id) => id !== task.id) : [...current, task.id]))
                    }
                  />
                  <span className="min-w-0">
                    <span className="block truncate">{task.title}</span>
                    {task.parentTitle ? <span className="block truncate text-xs text-muted">Subtask of {task.parentTitle}</span> : null}
                  </span>
                </label>
                <button
                  id={`unarchive-task-${task.id}`}
                  className="text-accent disabled:opacity-50"
                  type="button"
                  aria-label={`Unarchive ${task.title}`}
                  disabled={!online}
                  onClick={() => {
                    const focusRowUnarchive = () =>
                      focusSettingsControl(
                        `unarchive-task-${task.id}`,
                        "unarchive-selected",
                        "this-browser",
                      );
                    if (!online) {
                      toast.push("You are offline. Reconnect to unarchive.");
                      focusRowUnarchive();
                      return;
                    }
                    const taskId = task.id;
                    void api
                      .unarchiveTask(taskId)
                      .then(() => {
                        const restored = new Set([taskId, ...(task.parentId ? [task.parentId] : [])]);
                        for (const item of archived.data?.tasks ?? []) {
                          if (item.parentId === taskId) restored.add(item.id);
                        }
                        setArchivedChecked((current) => current.filter((id) => !restored.has(id)));
                        const childCount = (archived.data?.tasks ?? []).filter((item) => item.parentId === taskId).length;
                        const extra = task.parentId
                          ? " Its task was restored too."
                          : childCount === 1
                            ? " Its subtask was restored too."
                            : childCount > 1
                              ? " Its subtasks were restored too."
                              : "";
                        toast.push(`Task unarchived.${extra}`, {
                          label: "Undo",
                          run: () => {
                            if (!navigator.onLine) {
                              toast.push("You are offline. Reconnect to archive that task.");
                              focusRowUnarchive();
                              return;
                            }
                            void api
                              .archiveTask(taskId)
                              .then(() => {
                                toast.push("Task archived.");
                                focusRowUnarchive();
                                return queryClient.invalidateQueries({ queryKey: ["tasks"] });
                              })
                              .catch((error: unknown) => {
                                void queryClient.invalidateQueries({ queryKey: ["tasks"] });
                                toast.push(error instanceof ApiError ? error.message : "Could not archive that task.");
                                focusRowUnarchive();
                              });
                          },
                        });
                        focusRowUnarchive();
                        return queryClient.invalidateQueries({ queryKey: ["tasks"] });
                      })
                      .catch((error: unknown) => {
                        toast.push(error instanceof ApiError ? error.message : "Could not unarchive that task.");
                        focusRowUnarchive();
                      });
                  }}
                >
                  Unarchive
                </button>
              </li>
            ))}
            {archived.data.tasks.length === 0 ? (
              <li className="px-3 py-4 text-center text-sm text-muted" role="status">
                {archivedUndated ? (
                  <>
                    <p className="font-medium">No tasks match these filters</p>
                    <p className="mt-1">Clear filters to see every archived task again.</p>
                    <button className="mt-3 text-accent" type="button" aria-label="Clear archived filters" onClick={clearArchivedFilters}>
                      Clear filters
                    </button>
                  </>
                ) : (
                  "No archived tasks."
                )}
              </li>
            ) : null}
          </ul>
        ) : null}
      </section>
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Your data</h2>
        <p className="text-sm text-muted">
          Download a JSON file of your lists, tags, tasks, and occurrence history. Tasks on lists shared with you are included. The file does not include your password or push subscriptions. At most 5,000 tasks and 5,000 occurrence rows are included. Import adds a copy into this account. It does not replace what is already here, restore sharing, or change your plan.
        </p>
        {!online ? <p className="text-sm text-muted">You are offline. Reconnect to download or import.</p> : null}
        <div className="flex flex-wrap gap-2">
        <Button
          id="download-export"
          type="button"
          variant="secondary"
          aria-label="Download export"
          disabled={!online}
          onClick={() => {
            const focusExport = () => focusSettingsControl("download-export");
            if (!online) {
              toast.push("You are offline. Reconnect to download or import.");
              focusExport();
              return;
            }
            void api
              .exportAccount()
              .then((data) => {
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const link = document.createElement("a");
                link.href = url;
                link.download = "keepx-export.json";
                link.click();
                URL.revokeObjectURL(url);
                focusExport();
              })
              .catch((error: unknown) => {
                toast.push(error instanceof ApiError ? error.message : "Could not download the export.");
                focusExport();
              });
          }}
        >
          Download export
        </Button>
        <label
          id="import-export"
          tabIndex={-1}
          aria-label="Import export"
          aria-disabled={!online}
          className={`inline-flex items-center rounded-full border border-line bg-surface px-4 py-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-brand ${online ? "cursor-pointer" : "cursor-not-allowed opacity-50"}`}
        >
          Import export
          <input
            className="sr-only"
            type="file"
            accept="application/json,.json"
            disabled={!online}
            aria-label="Import export file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              const focusImport = () => focusSettingsControl("import-export");
              if (!online) {
                toast.push("You are offline. Reconnect to download or import.");
                focusImport();
                return;
              }
              void file
                .text()
                .then((text) => api.importAccount(JSON.parse(text) as Parameters<typeof api.importAccount>[0]))
                .then(async (result) => {
                  await queryClient.invalidateQueries({ queryKey: ["tasks"] });
                  await queryClient.invalidateQueries({ queryKey: ["lists"] });
                  await queryClient.invalidateQueries({ queryKey: ["tags"] });
                  const message =
                    result.tasks === 1 ? "Imported 1 task." : `Imported ${result.tasks} tasks.`;
                  const canUndo = result.listIds.length > 0 || result.tagIds.length > 0 || result.taskIds.length > 0;
                  if (!canUndo) {
                    toast.push(message);
                    focusImport();
                    return;
                  }
                  const listIds = result.listIds;
                  const tagIds = result.tagIds;
                  const taskIds = result.taskIds;
                  toast.push(message, {
                    label: "Undo",
                    run: () => {
                      if (!navigator.onLine) {
                        toast.push("You are offline. Reconnect to remove the import.");
                        focusImport();
                        return;
                      }
                      void api
                        .revertImport({ listIds, tagIds, taskIds })
                        .then(async () => {
                          await queryClient.invalidateQueries({ queryKey: ["tasks"] });
                          await queryClient.invalidateQueries({ queryKey: ["lists"] });
                          await queryClient.invalidateQueries({ queryKey: ["tags"] });
                          toast.push("Removed the import.");
                          focusImport();
                        })
                        .catch((error: unknown) => {
                          void queryClient.invalidateQueries({ queryKey: ["tasks"] });
                          void queryClient.invalidateQueries({ queryKey: ["lists"] });
                          void queryClient.invalidateQueries({ queryKey: ["tags"] });
                          toast.push(error instanceof ApiError ? error.message : "Could not remove the import.");
                          focusImport();
                        });
                    },
                  });
                  focusImport();
                })
                .catch((error: unknown) => {
                  toast.push(
                    error instanceof ApiError
                      ? error.message
                      : error instanceof SyntaxError
                        ? "That file is not a KeepX export."
                        : "Could not import that file.",
                  );
                  focusImport();
                });
            }}
          />
        </label>
        </div>
      </section>
      <form className="space-y-3" onSubmit={(event) => void removeAccount(event)}>
        <h2 className="text-lg font-medium">Delete account</h2>
        <p className="text-sm text-muted">
          This removes your lists, tags, tasks, reminders, sessions, and tokens. Tasks you added on someone else&apos;s list are removed. Tasks other people added on your lists move to their Inbox. If a subscription is still recorded, deletion is refused, because this server does not cancel it. Download an export first if you want a copy.
        </p>
        {!online ? <p className="text-sm text-muted">You are offline. Reconnect to delete the account.</p> : null}
        <Input
          id="delete-password"
          name="password"
          type="password"
          autoComplete="current-password"
          aria-label="Password to delete the account"
          required
          disabled={!online}
        />
        <label className="flex items-start gap-2 text-sm">
          <input
            id="confirm-delete"
            className="mt-1"
            type="checkbox"
            checked={confirmDelete}
            onChange={(event) => setConfirmDelete(event.target.checked)}
            disabled={!online}
          />
          <span>I understand this cannot be undone.</span>
        </label>
        <Button type="submit" variant="secondary" disabled={!online}>
          Delete account
        </Button>
      </form>
    </div>
  );
}

function LoadRetry({ error, label, onRetry }: { error: boolean; label: string; onRetry: () => void }) {
  if (!error) return null;
  return (
    <div className="text-sm">
      <p>{label}</p>
      <button className="mt-1 text-accent" type="button" aria-label={`${label} Try again`} onClick={onRetry}>
        Try again
      </button>
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
