export type PlatformId = "web" | "windows" | "macos" | "linux" | "ios" | "android" | "extension";
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
    status: "unavailable",
    unavailableReason: "No tested Windows package exists yet.",
    requirements: "System requirements will be published with the first tested build.",
  },
  {
    id: "macos",
    label: "macOS",
    status: "unavailable",
    unavailableReason: "No tested macOS package exists yet.",
    requirements: "System requirements will be published with the first tested build.",
  },
  {
    id: "linux",
    label: "Linux",
    status: "unavailable",
    unavailableReason: "No tested Linux package exists yet.",
    requirements: "System requirements will be published with the first tested build.",
  },
  {
    id: "ios",
    label: "iOS",
    status: "unavailable",
    unavailableReason: "There is no App Store listing.",
    requirements: "App Store requirements will be published with the first tested build.",
  },
  {
    id: "android",
    label: "Android",
    status: "unavailable",
    unavailableReason: "There is no Google Play listing.",
    requirements: "Play Store requirements will be published with the first tested build.",
  },
  {
    id: "extension",
    label: "Browser extension",
    status: "unavailable",
    unavailableReason: "The Chrome extension has not been built.",
    requirements: "A Chromium browser. Permissions will be listed with the extension.",
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
    note: "Billing is not connected. This plan cannot be purchased.",
    features: [
      "Desktop and mobile apps when those builds exist",
      "Reminders beyond the open web app",
      "Productivity reports",
    ],
  },
];
