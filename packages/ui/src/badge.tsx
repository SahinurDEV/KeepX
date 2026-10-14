import type { HTMLAttributes } from "react";
import { cn } from "./cn";

const tones = {
  neutral: "bg-sidebar text-ink",
  high: "bg-[hsl(var(--high)/0.15)] text-[hsl(var(--high))]",
  medium: "bg-[hsl(var(--medium)/0.15)] text-[hsl(var(--medium))]",
  low: "bg-[hsl(var(--low)/0.15)] text-[hsl(var(--low))]",
  accent: "bg-[hsl(var(--accent)/0.15)] text-accent",
};

export function Badge({
  tone = "neutral",
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: keyof typeof tones }) {
  return (
    <span
      className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", tones[tone], className)}
      {...props}
    />
  );
}
