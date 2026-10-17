"use client";

import { ApiError } from "@vela/api-client";
import { Button, Input } from "@vela/ui";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { useOnline } from "@/components/providers";
import { api } from "@/lib/api";

export function ResetForm() {
  const params = useSearchParams();
  const online = useOnline();
  const token = params.get("token") ?? "";
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tokenMissing = !token;

  function focusPassword() {
    queueMicrotask(() => {
      const field = document.getElementById("reset-password");
      if (field instanceof HTMLInputElement && !field.disabled) {
        field.focus();
        return;
      }
      (document.getElementById("forgot-reset-link") ?? document.getElementById("content"))?.focus();
    });
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (tokenMissing) {
      setError("This reset link is missing a token.");
      focusPassword();
      return;
    }
    if (!online) {
      setError("You are offline. Reconnect to update the password.");
      focusPassword();
      return;
    }
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      await api.resetPassword({ token, password: String(form.get("password") ?? "") });
      setDone(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "The request failed.");
      focusPassword();
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <p className="mt-6 text-sm">
        Password updated.{" "}
        <Link className="text-accent" href="/login">
          Sign in
        </Link>
      </p>
    );
  }

  const invalid = Boolean(error);
  const describedBy = [error ? "reset-error" : null, tokenMissing ? "reset-missing-token" : null]
    .filter(Boolean)
    .join(" ") || undefined;

  return (
    <form className="mt-6 space-y-4" onSubmit={(event) => void onSubmit(event)}>
      {!online ? <p className="text-sm text-muted">You are offline. Reconnect to update the password.</p> : null}
      <label className="block text-sm">
        New password
        <Input
          id="reset-password"
          className="mt-1"
          name="password"
          type="password"
          required
          minLength={10}
          autoComplete="new-password"
          autoFocus={!tokenMissing}
          disabled={!online || tokenMissing}
          aria-invalid={invalid || tokenMissing || undefined}
          aria-describedby={describedBy}
        />
      </label>
      {tokenMissing ? (
        <p id="reset-missing-token" className="text-sm text-danger" role="alert">
          This reset link is missing a token.{" "}
          <Link id="forgot-reset-link" className="text-accent" href="/forgot">
            Request a new link
          </Link>
        </p>
      ) : null}
      {error ? (
        <p id="reset-error" className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <Button className="w-full" type="submit" disabled={pending || tokenMissing || !online}>
        {pending ? "Please wait…" : "Update password"}
      </Button>
    </form>
  );
}
