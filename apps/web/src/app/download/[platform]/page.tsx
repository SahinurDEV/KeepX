import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PLATFORM_CATALOG, type PlatformId } from "@vela/shared";
import { SiteFrame } from "@/components/site-frame";

const ids = new Set(PLATFORM_CATALOG.map((item) => item.id));

export function generateStaticParams() {
  return PLATFORM_CATALOG.map((item) => ({ platform: item.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ platform: string }> }): Promise<Metadata> {
  const { platform } = await params;
  const item = PLATFORM_CATALOG.find((entry) => entry.id === platform);
  return { title: item ? item.label : "Download" };
}

export default async function PlatformPage({ params }: { params: Promise<{ platform: string }> }) {
  const { platform } = await params;
  if (!ids.has(platform as PlatformId)) notFound();
  const item = PLATFORM_CATALOG.find((entry) => entry.id === platform);
  if (!item) notFound();
  return (
    <SiteFrame>
      <div className="mx-auto max-w-3xl px-5 py-16">
        <Link className="text-sm text-muted" href="/download">
          All platforms
        </Link>
        <h1 className="mt-4 font-serif text-5xl">{item.label}</h1>
        <p className="mt-4 text-muted">{item.requirements}</p>
        {item.version ? <p className="mt-4">Version {item.version}</p> : <p className="mt-4">No versioned package is published.</p>}
        {item.releaseNotes ? <p className="mt-2">{item.releaseNotes}</p> : null}
        {item.checksum ? <p className="mt-4 font-mono text-sm">Checksum {item.checksum}</p> : <p className="mt-4 text-sm text-muted">No checksum is published.</p>}
        {item.status === "available" && item.href ? (
          <Link className="mt-6 inline-flex rounded-lg bg-accent px-4 py-2 font-medium text-accent-ink" href={item.href}>
            Continue
          </Link>
        ) : (
          <p className="mt-6 rounded-xl border border-line bg-surface p-4">{item.unavailableReason}</p>
        )}
      </div>
    </SiteFrame>
  );
}
