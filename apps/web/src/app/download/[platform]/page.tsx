import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PLATFORM_CATALOG, type PlatformId } from "@vela/shared";
import { SiteFrame } from "@/components/site-frame";

const ids = new Set(PLATFORM_CATALOG.map((item) => item.id));

const STEPS: Partial<Record<PlatformId, string[]>> = {
  web: ["Open the link.", "Sign in or create an account.", "Use Inbox, lists, calendar, and settings in the browser."],
  windows: [
    "Download the portable .exe.",
    "Start the KeepX web app and API on this computer (default http://127.0.0.1:3000).",
    "Run the unsigned file. Windows may warn because it is not code-signed.",
    "Ctrl+Shift+K focuses quick add. Due reminders can raise a Windows notification.",
  ],
  linux: [
    "Download the AppImage.",
    "Start the KeepX web app and API on that computer.",
    "Mark the file executable, then open it.",
    "Ctrl+Shift+K focuses quick add.",
    "Due reminders can raise a Linux notification when the desktop supports it.",
  ],
  android: [
    "Download the unsigned debug APK for arm64.",
    "Allow installs from this source on the phone.",
    "Open the file to install. This is a native Expo app, not a website inside a WebView.",
    "At sign-in, set the API address: emulator http://10.0.2.2:4000, or this computer’s LAN address for a real phone.",
    "Sign in. The app is a native Expo client that calls the API — not a website inside a WebView.",
    "Use Inbox to add and complete tasks. The apps/mobile source also has Today and All; rebuild the APK when your project path allows (paths with parentheses break the Android NDK build).",
    "This package does not register an Expo push token, so phone push does not work until a later build does.",
  ],
  chrome: [
    "Download and unzip the file.",
    "Open chrome://extensions and turn on Developer mode.",
    "Choose Load unpacked and select the unzipped folder.",
    "Create a token in KeepX Settings → App tokens, then paste it in the extension.",
    "Use Add task or Save this tab. Open KeepX opens the local web app.",
  ],
  edge: [
    "Download and unzip the file.",
    "Open edge://extensions and turn on Developer mode.",
    "Choose Load unpacked and select the unzipped folder.",
    "Create a token in KeepX Settings → App tokens, then paste it in the extension.",
    "Use Add task or Save this tab. Open KeepX opens the local web app.",
  ],
  firefox: [
    "Download the .xpi file.",
    "Open about:debugging → This Firefox → Load Temporary Add-on.",
    "Choose the .xpi file.",
    "Create a token in KeepX Settings → App tokens, then paste it in the extension.",
    "Use Add task or Save this tab.",
  ],
  gmail: [
    "Download the zip and read INSTALL.txt inside it.",
    "Publish KeepX on a public https address first. Google cannot reach localhost.",
    "Install the Apps Script project with clasp or the editor steps in INSTALL.txt.",
    "This is not a Google Workspace Marketplace listing.",
  ],
};

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
  const steps = STEPS[item.id] ?? [];
  return (
    <SiteFrame>
      <div className="mx-auto max-w-3xl px-5 py-16">
        <Link className="text-sm text-muted hover:text-accent" href="/download">
          All platforms
        </Link>
        <h1 className="mt-4 font-serif text-5xl tracking-tight">{item.label}</h1>
        <p className="mt-4 text-muted leading-7">{item.requirements}</p>
        {item.version ? <p className="mt-4">Version {item.version}</p> : <p className="mt-4">No versioned package is published.</p>}
        {item.releaseNotes ? <p className="mt-2 text-muted">{item.releaseNotes}</p> : null}
        {item.checksum ? <p className="mt-4 break-all font-mono text-sm">Checksum {item.checksum}</p> : <p className="mt-4 text-sm text-muted">No checksum is published.</p>}
        {steps.length > 0 ? (
          <ol className="mt-8 list-decimal space-y-3 pl-5 text-sm leading-6 text-ink">
            {steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        ) : null}
        {item.status === "available" && item.href ? (
          <Link className="mt-8 inline-flex rounded-full bg-accent px-4 py-2 font-medium text-accent-ink" href={item.href}>
            {item.href === "/login" ? "Continue" : "Download"}
          </Link>
        ) : (
          <p className="mt-8 rounded-xl border border-line bg-surface p-4">{item.unavailableReason}</p>
        )}
      </div>
    </SiteFrame>
  );
}
