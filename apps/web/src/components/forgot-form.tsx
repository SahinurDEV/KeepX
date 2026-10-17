"use client";

import { ApiError } from "@vela/api-client";
import { Button, Input } from "@vela/ui";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useOnline } from "@/components/providers";
import { api } from "@/lib/api";

export function ForgotForm() {
  const online = useOnline();
  const meta = useQuery({ queryKey: ["meta"], queryFn: () => api.meta() });
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recoveryBlocked = meta.data?.emailRecovery === false;

  function focusEmail() {
    queueMicrotask(() => {
      const field = document.getElementById("forgot-email");
      if (field instanceof HTMLInputElement && !field.disabled) {
        field.focus();
        return;
      }
      (document.getElementById("forgot-login-link") ?? document.getElementById("content"))?.focus();
    });
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!online) {
      setError("You are offline. Reconnect to request a reset link.");
      focusEmail();
      return;
    }
    if (recoveryBlocked) {
      setError("Password recovery email is not configured.");
      focusEmail();
      return;
    }
    const form = new FormData(event.currentTarget);
    setPending(true);
    setMessage(null);
    setError(null);
    try {
      await api.requestRecovery({ email: String(form.get("email") ?? "") });
      setMessage("If an account exists for that address, a reset link is on its way. The link works for one hour.");
      focusEmail();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "The request failed.");
      focusEmail();
    } finally {
      setPending(false);
    }
  }

  const invalid = Boolean(error);
  const describedBy =
    [error ? "forgot-error" : null, recoveryBlocked ? "forgot-recovery-blocked" : null].filter(Boolean).join(" ") ||
    undefined;

  return (
    <>
      <p className="mt-2 text-sm text-muted">Enter the email on the account. The reply is the same whether or not that account exists.</p>
      {meta.isLoading ? (
        <p className="mt-2 text-sm text-muted" role="status">
          Loading server options…
        </p>
      ) : null}
      {recoveryBlocked ? (
        <p id="forgot-recovery-blocked" className="mt-2 text-sm text-muted" role="status">
          Password recovery email is not configured.
        </p>
      ) : null}
      {meta.isError ? (
        <p className="mt-2 text-sm text-muted">Server options could not be loaded. You can still try Send reset link.</p>
      ) : null}
      <form className="mt-6 space-y-4" onSubmit={(event) => void onSubmit(event)}>
        {!online ? <p className="text-sm text-muted">You are offline. Reconnect to request a reset link.</p> : null}
        <label className="block text-sm">
          Email
          <Input
            id="forgot-email"
            className="mt-1"
            name="email"
            type="email"
            required
            autoComplete="email"
            autoFocus={!recoveryBlocked}
            disabled={!online || recoveryBlocked}
            aria-invalid={invalid || recoveryBlocked || undefined}
            aria-describedby={describedBy}
          />
        </label>
        {message ? (
          <p id="forgot-message" className="text-sm" role="status">
            {message}
          </p>
        ) : null}
        {error ? (
          <p id="forgot-error" className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <Button className="w-full" type="submit" disabled={pending || !online || recoveryBlocked || meta.isLoading}>
          {pending ? "Please wait…" : "Send reset link"}
        </Button>
      </form>
      <p className="mt-4 text-sm text-muted">
        <Link id="forgot-login-link" className="text-accent" href="/login">
          Back to sign in
        </Link>
      </p>
    </>
  );
}
