import type { Metadata } from "next";
import { Figtree, Fraunces } from "next/font/google";
import Script from "next/script";
import { Providers } from "@/components/providers";
import { appName } from "@/lib/api";
import "./globals.css";

const sans = Figtree({ subsets: ["latin"], variable: "--font-sans" });
const serif = Fraunces({ subsets: ["latin"], variable: "--font-serif" });

export const metadata: Metadata = {
  title: { default: appName(), template: `%s · ${appName()}` },
  description: "A private task manager for lists, due dates, and a calendar that stays in your time zone.",
};

const themeScript = `try{var t=localStorage.getItem("vela-theme");var dark=t==="dark"||((!t||t==="system")&&matchMedia("(prefers-color-scheme: dark)").matches);if(dark)document.documentElement.classList.add("dark");}catch(e){}`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${sans.variable} ${serif.variable} font-sans antialiased`}>
        <Script id="vela-theme" strategy="beforeInteractive">
          {themeScript}
        </Script>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
