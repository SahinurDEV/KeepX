import Link from "next/link";
import type { ReactNode } from "react";
import { appName } from "@/lib/api";

export function Mark({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 32 32">
      <circle cx="16" cy="16" r="15" className="fill-accent" />
      <path d="M9.2 16.4 14 21.1 22.8 11.2" fill="none" className="stroke-accent-ink" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const links = [
  ["Features", "/features"],
  ["Pricing", "/pricing"],
  ["Download", "/download"],
  ["Help", "/help"],
];

export function SiteFrame({ children }: { children: ReactNode }) {
  const name = appName();
  return (
    <div className="min-h-screen">
      <a className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:bg-surface focus:px-3 focus:py-2" href="#content">
        Skip to content
      </a>
      <header className="sticky top-0 z-30 bg-bg/75 backdrop-blur">
        <div className="relative mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
          <Link className="flex items-center gap-2 text-lg font-semibold text-accent" href="/">
            <Mark className="h-7 w-7" />
            {name}
          </Link>
          <nav className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-8 text-sm text-ink md:flex">
            {links.map(([label, href]) => (
              <Link key={href} className="hover:text-accent" href={href ?? "/"}>
                {label}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <Link className="rounded-full px-3 py-2 text-sm text-ink hover:text-accent" href="/login">
              Sign in
            </Link>
            <Link className="rounded-full border border-line bg-surface px-4 py-1.5 text-sm text-ink hover:border-accent hover:text-accent" href="/signup">
              Sign up for free
            </Link>
          </div>
        </div>
        <nav className="flex gap-4 overflow-x-auto px-5 pb-3 text-sm text-muted md:hidden">
          {links.map(([label, href]) => (
            <Link key={href} className="shrink-0 hover:text-accent" href={href ?? "/"}>
              {label}
            </Link>
          ))}
        </nav>
      </header>
      <main id="content">{children}</main>
      <footer className="mx-auto mt-20 grid max-w-6xl gap-6 border-t border-line px-5 py-10 text-sm text-muted md:grid-cols-[1.4fr_1fr_1fr]">
        <div>
          <p className="font-medium text-ink">{name}</p>
          <p className="mt-2 max-w-xs">A private list for the work that belongs to today.</p>
        </div>
        <div className="flex flex-col gap-2">
          {links.map(([label, href]) => (
            <Link key={href} href={href ?? "/"}>
              {label}
            </Link>
          ))}
        </div>
        <div className="flex flex-col gap-2">
          <Link href="/login">Sign in</Link>
          <Link href="/signup">Create account</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
        </div>
      </footer>
    </div>
  );
}
