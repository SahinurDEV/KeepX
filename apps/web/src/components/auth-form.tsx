"use client";

import { ApiError } from "@vela/api-client";
import { Button, Input } from "@vela/ui";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { api, safeNext } from "@/lib/api";

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const next = safeNext(params.get("next"));

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      {mode === "signup" ? (
        <label className="block text-sm">
          Name
          <Input className="mt-1" name="name" required autoComplete="name" />
        </label>
      ) : null}
      <label className="block text-sm">
        Email
        <Input className="mt-1" name="email" type="email" required autoComplete="email" />
      </label>
      <label className="block text-sm">
        Password
        <Input className="mt-1" name="password" type="password" required minLength={mode === "signup" ? 10 : 1} autoComplete={mode === "signup" ? "new-password" : "current-password"} />
      </label>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <Button className="w-full" type="submit" disabled={pending}>
        {pending ? "Please wait…" : mode === "signup" ? "Create account" : "Sign in"}
      </Button>
      {mode === "login" ? (
        <p className="text-sm text-muted">
          Password recovery email is not configured. You can change a password from Settings after signing in.
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
