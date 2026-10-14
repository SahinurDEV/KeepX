import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cn } from "./cn";

const field = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(field, "h-10", className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(field, "min-h-28 resize-y", className)} {...props} />;
}
