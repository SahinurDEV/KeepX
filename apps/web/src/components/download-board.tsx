"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PLATFORM_CATALOG, type PlatformId } from "@vela/shared";

function detectPlatform(): PlatformId {
  const agent = navigator.userAgent.toLowerCase();
  if (agent.includes("android")) return "android";
  if (agent.includes("iphone") || agent.includes("ipad")) return "ios";
  if (agent.includes("win")) return "windows";
  if (agent.includes("mac")) return "macos";
  if (agent.includes("linux")) return "linux";
  return "web";
}

export function DownloadBoard() {
  const [detected, setDetected] = useState<PlatformId>("web");
  useEffect(() => setDetected(detectPlatform()), []);
  const suggestion = PLATFORM_CATALOG.find((item) => item.id === detected) ?? PLATFORM_CATALOG[0];

  return (
    <div>
      {suggestion ? (
        <div className="rounded-2xl border border-line bg-sidebar px-5 py-4">
          <p className="text-sm text-muted">Suggested for this device</p>
          <p className="mt-1 text-lg font-medium">{suggestion.label}</p>
          {suggestion.status === "available" && suggestion.href ? (
            <Link className="mt-3 inline-flex rounded-full bg-accent px-3 py-2 text-sm font-medium text-accent-ink" href={suggestion.href}>
              Open {suggestion.label}
            </Link>
          ) : (
            <p className="mt-2 text-sm">{suggestion.unavailableReason} Use the web app in the meantime.</p>
          )}
        </div>
      ) : null}
      <div className="mt-8 grid gap-4 md:grid-cols-2">
        {PLATFORM_CATALOG.map((item) => (
          <article key={item.id} className="rounded-2xl border border-line bg-surface p-5" id={item.id}>
            <h2 className="text-xl font-medium">{item.label}</h2>
            <p className="mt-2 text-sm text-muted">{item.requirements}</p>
            {item.version ? <p className="mt-2 text-sm">Version {item.version}</p> : null}
            {item.releaseNotes ? <p className="mt-1 text-sm text-muted">{item.releaseNotes}</p> : null}
            {item.checksum ? <p className="mt-2 font-mono text-xs">Checksum {item.checksum}</p> : null}
            {item.status === "available" && item.href ? (
              <Link className="mt-4 inline-flex text-sm font-medium text-accent" href={item.href}>
                Open
              </Link>
            ) : (
              <p className="mt-4 text-sm font-medium">Unavailable. {item.unavailableReason}</p>
            )}
            <Link className="mt-3 block text-sm text-muted underline" href={`/download/${item.id}`}>
              Platform details
            </Link>
          </article>
        ))}
      </div>
    </div>
  );
}
