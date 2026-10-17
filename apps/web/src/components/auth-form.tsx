"use client";

import { ApiError } from "@vela/api-client";
import { Button, Input } from "@vela/ui";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { useOnline } from "@/components/providers";
import { api, safeNext } from "@/lib/api";

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const params = useSearchParams();
  const online = useOnline();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const next = safeNext(params.get("next"));
  const focusField = mode === "signup" ? "auth-name" : "auth-email";

  function focusFirstField() {
    queueMicrotask(() => document.getElementById(focusField)?.focus());
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!online) {
      setError(`You are offline. Reconnect to ${mode === "signup" ? "create an account" : "sign in"}.`);
      focusFirstField();
      return;
    }
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      if (mode === "signup") {
        await api.register({
          name: String(form.get("name") ?? ""),
          email: String(form.get("email") ?? ""),
          password: String(form.get("password") ?? ""),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        });
      } else {
        await api.login({
          email: String(form.get("email") ?? ""),
          password: String(form.get("password") ?? ""),
        });
      }
      router.push(mode === "signup" ? "/inbox" : next);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "The request failed.");
      focusFirstField();
    } finally {
      setPending(false);
    }
  }

  const invalid = Boolean(error);
  const describedBy = error ? "auth-error" : undefined;

  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      {!online ? <p className="text-sm text-muted">You are offline. Reconnect to {mode === "signup" ? "create an account" : "sign in"}.</p> : null}
      {mode === "signup" ? (
        <label className="block text-sm">
          Name
          <Input
            id="auth-name"
            className="mt-1"
            name="name"
            required
            autoComplete="name"
            autoFocus
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
          />
        </label>
      ) : null}
      <label className="block text-sm">
        Email
        <Input
          id="auth-email"
          className="mt-1"
          name="email"
          type="email"
          required
          autoComplete="email"
          autoFocus={mode === "login"}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
        />
      </label>
      <label className="block text-sm">
        Password
        <Input
          id="auth-password"
          className="mt-1"
          name="password"
          type="password"
          required
          minLength={mode === "signup" ? 10 : 1}
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
        />
      </label>
      {error ? (
        <p id="auth-error" className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <Button className="w-full" type="submit" disabled={pending || !online}>
        {pending ? "Please wait…" : mode === "signup" ? "Create account" : "Sign in"}
      </Button>
      {mode === "login" ? (
        <p className="text-sm text-muted">
          <Link className="text-accent" href="/forgot">Forgot password?</Link>
        </p>
      ) : null}
      <p className="text-sm text-muted">
        {mode === "login" ? (
          <>
            New here? <Link className="text-accent" href="/signup">Create an account</Link>
          </>
        ) : (
          <>
            Already registered? <Link className="text-accent" href="/login">Sign in</Link>
          </>
        )}
      </p>
    </form>
  );
}
