import type { Metadata } from "next";
import { DownloadBoard } from "@/components/download-board";
import { SiteFrame } from "@/components/site-frame";
import { appName } from "@/lib/api";

export const metadata: Metadata = { title: "Download" };

export default function DownloadPage() {
  return (
    <SiteFrame>
      <div className="mx-auto max-w-5xl px-5 py-16">
        <h1 className="font-serif text-5xl">Download {appName()}</h1>
        <p className="mt-4 max-w-2xl text-muted">
          The web app is ready. Desktop, mobile, and extension downloads appear here only after a tested build exists.
        </p>
        <div className="mt-8">
          <DownloadBoard />
        </div>
      </div>
    </SiteFrame>
  );
}
