import type { Metadata } from "next";
import { DownloadBoard } from "@/components/download-board";
import { SiteFrame } from "@/components/site-frame";
import { appName } from "@/lib/api";

export const metadata: Metadata = { title: "Download" };

export default function DownloadPage() {
  return (
    <SiteFrame>
      <div className="mx-auto max-w-5xl px-5 pb-20 pt-10 md:pt-14">
        <DownloadBoard />
        <p className="mt-12 max-w-2xl text-sm leading-6 text-muted">
          {appName()} checksums are listed under each file. Windows and Linux desktop shells need the web app and API already running on this machine. The Android APK needs an API it can reach on your network. Extensions load unpacked and talk only to http://127.0.0.1:3000 with a Settings token.
        </p>
      </div>
    </SiteFrame>
  );
}
