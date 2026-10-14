import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "./cn";

const buttonStyles = cva(
  "inline-flex items-center justify-center gap-2 rounded-full text-sm font-medium transition disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-ink hover:opacity-90",
        secondary: "border border-line bg-surface text-ink hover:bg-sidebar",
        ghost: "text-ink hover:bg-sidebar",
        danger: "bg-danger text-white hover:opacity-90",
      },
      size: {
        sm: "h-8 px-2.5",
        md: "h-10 px-3.5",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonStyles> {
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild, type = "button", ...props }: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonStyles({ variant, size }), className)} type={asChild ? undefined : type} {...props} />;
}
