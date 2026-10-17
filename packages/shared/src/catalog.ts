export type PlatformId =
  | "web"
  | "windows"
  | "macos"
  | "linux"
  | "ios"
  | "android"
  | "chrome"
  | "edge"
  | "firefox"
  | "gmail";
export type PlatformStatus = "available" | "unavailable";

export interface PlatformRelease {
  id: PlatformId;
  label: string;
  status: PlatformStatus;
  /** Present only when status is available. */
  href?: string;
  unavailableReason?: string;
  requirements: string;
  version?: string;
  checksum?: string;
  releaseNotes?: string;
}

export const PLATFORM_CATALOG: PlatformRelease[] = [
  {
    id: "web",
    label: "Web app",
    status: "available",
    href: "/login",
    requirements: "A current version of Chrome, Firefox, Safari, or Edge.",
    version: "0.1.0",
    releaseNotes: "Sign in, lists, tasks, calendar, and in-app reminders.",
  },
  {
    id: "windows",
    label: "Windows",
    status: "available",
    href: "/downloads/KeepX-0.1.0-win-x64.exe",
    requirements:
      "Windows 10 or later. The portable app is unsigned. It opens http://127.0.0.1:3000, so the KeepX web app and API must already be running on this computer.",
    version: "0.1.0",
    checksum: "sha256:0ddcd24b88b8095c06413d643b62501f6885af8bd446432881cae72a0c2e0561",
    releaseNotes: "A desktop window around the local web app. Ctrl+Shift+K focuses quick add. Due reminders can raise a Windows notification.",
  },
  {
    id: "macos",
    label: "macOS",
    status: "unavailable",
    unavailableReason: "A macOS app has to be built on a Mac. This computer is Windows, so there is no file to download.",
    requirements: "macOS requirements will be published with the first tested build.",
  },
  {
    id: "linux",
    label: "Linux",
    status: "unavailable",
    unavailableReason:
      "A Linux AppImage was built locally, but GitHub rejects files over 100 MB, so there is no hosted download. Build from apps/desktop on a Linux host if you need the file.",
    requirements: "64-bit Linux. Build steps are in docs/platform-builds.md.",
  },
  {
    id: "ios",
    label: "iOS & iPadOS",
    status: "unavailable",
    unavailableReason: "An iPhone and iPad app has to be built on a Mac. This computer is Windows, so there is no file to download.",
    requirements: "App Store requirements will be published with the first tested build.",
  },
  {
    id: "android",
    label: "Android",
    status: "available",
    href: "/downloads/KeepX-0.1.0-android.apk",
    requirements:
      "An arm64 Android phone. This is an unsigned debug APK, not a Play Store listing. Allow installs from this source, then open the file. At sign-in, point the app at an API it can reach: an emulator can use http://10.0.2.2:4000, and a phone on the same network needs this computer's address. Cleartext http is allowed.",
    version: "0.1.0",
    checksum: "sha256:a0907165909031b23105f17515cc539e2c3fbdd8d35617c8127e0293225669fb",
    releaseNotes:
      "Native Expo client (API client, not a website shell). The published APK signs in, lists Inbox, adds a task, and completes on tap. The apps/mobile source also has Today, All, due dates, and Sign out — rebuild the APK from a path without parentheses to ship those screens. This package does not register an Expo push token, so phone push does not work until a later build does.",
  },
  {
    id: "chrome",
    label: "Chrome extension",
    status: "available",
    href: "/downloads/KeepX-0.1.0-chrome.zip",
    requirements:
      "Chrome. Unzip the file and choose Load unpacked at chrome://extensions. It talks only to http://127.0.0.1:3000. Create a token in Settings first. This is not a Chrome Web Store listing.",
    version: "0.1.0",
    checksum: "sha256:2c36ac50a40f213c826fc379d53619343ea58e5572d7cccaf914194dac219ecf",
    releaseNotes: "Quick add, save the open tab into Inbox, and open KeepX or Settings from the popup.",
  },
  {
    id: "edge",
    label: "Microsoft Edge extension",
    status: "available",
    href: "/downloads/KeepX-0.1.0-edge.zip",
    requirements:
      "Microsoft Edge. Unzip the file and choose Load unpacked at edge://extensions. It talks only to http://127.0.0.1:3000. Create a token in Settings first. This is not an Edge Add-ons listing.",
    version: "0.1.0",
    checksum: "sha256:2c36ac50a40f213c826fc379d53619343ea58e5572d7cccaf914194dac219ecf",
    releaseNotes: "The same extension as Chrome. Quick add, save the open tab, and open KeepX or Settings from the popup.",
  },
  {
    id: "firefox",
    label: "Firefox extension",
    status: "available",
    href: "/downloads/KeepX-0.1.0-firefox.xpi",
    requirements:
      "Firefox 128 or later. Load the file from about:debugging as a temporary add-on. It talks only to http://127.0.0.1:3000. Create a token in Settings first. This is not on addons.mozilla.org.",
    version: "0.1.0",
    checksum: "sha256:497e42167430e692659fb71d568ae65856c08f75f5da1da37860894012dcdd1a",
    releaseNotes: "Quick add, save the open tab into Inbox, and open KeepX or Settings from the popup.",
  },
  {
    id: "gmail",
    label: "Gmail add-on",
    status: "available",
    href: "/downloads/KeepX-0.1.0-gmail.zip",
    requirements:
      "A Google account. This is not a Marketplace listing. Google runs the script, so it cannot reach KeepX on this computer. Install the project from the zip only after KeepX has a public https address. The steps are in INSTALL.txt.",
    version: "0.1.0",
    checksum: "sha256:0c4c4228f1ac4a02cc406b5724f33cbbeffacd611b46adca279c90c6c5e16789",
    releaseNotes: "Saves the open Gmail subject into KeepX Inbox when the script can reach your API.",
  },
];

export function assertCatalogIntegrity(catalog: PlatformRelease[] = PLATFORM_CATALOG): void {
  for (const item of catalog) {
    if (item.status === "available" && !item.href) {
      throw new Error(`${item.id} is marked available without a link.`);
    }
    if (item.status === "unavailable" && item.href) {
      throw new Error(`${item.id} is unavailable but still has a link.`);
    }
  }
}

export interface PricingPlan {
  id: string;
  name: string;
  priceLabel: string;
  available: boolean;
  note: string;
  features: string[];
}

export const PRICING_PLANS: PricingPlan[] = [
  {
    id: "personal",
    name: "Personal",
    priceLabel: "Free",
    available: true,
    note: "The current product. No payment is collected.",
    features: [
      "Tasks, lists, tags, and subtasks",
      "Due dates, priorities, and recurrence",
      "Calendar and in-app reminders",
      "One private workspace",
    ],
  },
  {
    id: "plus",
    name: "Plus",
    priceLabel: "Not for sale",
    available: false,
    note: "Billing is not connected. No payment is collected, and this plan grants nothing extra.",
    features: ["No additional features"],
  },
];
