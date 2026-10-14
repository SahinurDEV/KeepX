import { createApiClient } from "@vela/api-client";

export const api = createApiClient("");

export function appName(): string {
  return process.env.NEXT_PUBLIC_APP_NAME?.trim() || "Vela";
}

export function safeNext(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/login")) return "/inbox";
  return value;
}
