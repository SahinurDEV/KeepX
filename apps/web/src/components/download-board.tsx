"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PLATFORM_CATALOG, type PlatformId, type PlatformRelease } from "@vela/shared";
import { Mark } from "@/components/site-frame";
import { appName } from "@/lib/api";

function detectPlatform(): PlatformId {
  const agent = navigator.userAgent.toLowerCase();
  if (agent.includes("android")) return "android";
  if (agent.includes("iphone") || agent.includes("ipad")) return "ios";
  if (agent.includes("win")) return "windows";
  if (agent.includes("mac")) return "macos";
  if (agent.includes("linux")) return "linux";
  return "web";
}

const GROUPS: { title: string; blurb: string; ids: PlatformId[] }[] = [
  {
    title: "On this computer",
    blurb: "Desktop windows around your local KeepX server. They are not store listings.",
    ids: ["windows", "linux", "macos"],
  },
  {
    title: "On your phone",
    blurb: "A native Android build talks to the API. It is not a browser shell wrapped in a WebView.",
    ids: ["android", "ios"],
  },
  {
    title: "In the browser",
    blurb:
      "Use the full web app or a local extension for quick add and save-tab. The Gmail add-on only works after KeepX is on a public https address.",
    ids: ["web", "chrome", "edge", "firefox", "gmail"],
  },
];

function byId(id: PlatformId): PlatformRelease | undefined {
  return PLATFORM_CATALOG.find((item) => item.id === id);
}

function DownloadAction({ item, large }: { item: PlatformRelease; large?: boolean }) {
  if (item.status === "available" && item.href) {
    const label = item.href === "/login" ? `Open ${item.label}` : `Download ${item.label}`;
    return (
      <Link
        className={
          large
            ? "mt-5 inline-flex rounded-full bg-accent px-5 py-2.5 text-sm font-medium text-accent-ink"
            : "mt-4 inline-flex rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-ink"
        }
        href={item.href}
      >
        {label}
      </Link>
    );
  }
  return <p className="mt-4 text-sm font-medium text-muted">Unavailable. {item.unavailableReason}</p>;
}

function PlatformRow({ item }: { item: PlatformRelease }) {
  return (
    <article className="border-t border-line/80 py-5 first:border-t-0 first:pt-0" id={item.id}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-xl">
          <h3 className="text-lg font-medium text-ink">{item.label}</h3>
          <p className="mt-1 text-sm leading-6 text-muted">{item.requirements}</p>
          {item.version ? <p className="mt-2 text-sm text-ink">Version {item.version}</p> : null}
          {item.releaseNotes ? <p className="mt-1 text-sm text-muted">{item.releaseNotes}</p> : null}
          {item.checksum ? <p className="mt-2 break-all font-mono text-[11px] text-muted">Checksum {item.checksum}</p> : null}
        </div>
        <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
          <DownloadAction item={item} />
          <Link className="text-sm text-muted underline decoration-line underline-offset-4 hover:text-accent" href={`/download/${item.id}`}>
            Install steps
          </Link>
        </div>
      </div>
    </article>
  );
}

export function DownloadBoard() {
  const [detected, setDetected] = useState<PlatformId | null>(null);
  useEffect(() => setDetected(detectPlatform()), []);
  const matched = detected ? byId(detected) : null;
  const suggestion = detected
    ? matched?.status === "available"
      ? matched
      : byId("web") ?? PLATFORM_CATALOG.find((item) => item.status === "available") ?? null
    : null;
  const name = appName();

  return (
    <div>
      <section className="relative overflow-hidden rounded-[2rem] border border-line bg-[radial-gradient(120%_80%_at_10%_0%,hsl(var(--accent)/0.18),transparent_55%),linear-gradient(160deg,hsl(var(--sidebar)),hsl(var(--bg)))] px-6 py-10 md:px-10 md:py-14">
        <div className="pointer-events-none absolute -right-16 top-8 h-56 w-56 rounded-full bg-accent/10 blur-2xl" aria-hidden="true" />
        <div className="relative max-w-2xl">
          <div className="flex items-center gap-3">
            <Mark className="h-10 w-10" />
            <p className="font-serif text-3xl tracking-tight text-accent md:text-4xl">{name}</p>
          </div>
          <h1 className="mt-6 font-serif text-4xl leading-tight tracking-tight text-ink md:text-5xl">Install the client that fits this device.</h1>
          <p className="mt-4 max-w-xl text-base leading-7 text-muted">
            Files on this page are real packages from this repo. Desktop opens your local web app. Android is a native Expo build. Browser extensions add tasks through your API token. macOS and iOS stay off until a Mac builds them.
          </p>
          {suggestion ? (
            <div className="mt-8">
              <p className="text-sm text-muted">Suggested for this device</p>
              <p className="mt-1 text-xl font-medium text-ink">{suggestion.label}</p>
              <DownloadAction item={suggestion} large />
            </div>
          ) : (
            <p className="mt-8 text-sm text-muted" role="status">
              Checking this device…
            </p>
          )}
        </div>
      </section>

      <div className="mt-14 space-y-14">
        {GROUPS.map((group) => (
          <section key={group.title}>
            <h2 className="font-serif text-3xl tracking-tight text-ink">{group.title}</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">{group.blurb}</p>
            <div className="mt-6 rounded-2xl border border-line bg-surface/80 px-5 py-2 md:px-7">
              {group.ids.map((id) => {
                const item = byId(id);
                return item ? <PlatformRow key={id} item={item} /> : null;
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
