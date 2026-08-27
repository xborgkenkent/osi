import type { Metadata } from "next";
import { IBM_Plex_Mono, Outfit } from "next/font/google";
import "./globals.css";

const outfit = Outfit({
  variable: "--font-body",
  subsets: ["latin"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "OSI — URL Checker",
  description: "Check whether one or more URLs are reachable and return OK.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${outfit.variable} ${plexMono.variable} h-full`}>
      <body className="min-h-full antialiased">{children}</body>
    </html>
  );
}
