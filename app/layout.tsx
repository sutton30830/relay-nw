import type { Metadata, Viewport } from "next";
import { Instrument_Serif, Inter } from "next/font/google";
import { SiteFooter } from "@/components/site-footer";
import { PwaRegistration } from "@/components/pwa-registration";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-instrument-serif",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Relay NW",
  description: "Relay NW is a missed-call recovery service operated by Lowry Works LLC.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Relay NW",
  },
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0f4b44",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // The font variable classes must live on <html>: globals.css composes them
    // into --font-display/--font-ui inside :root, and a custom property whose
    // var() reference is missing at that scope collapses to invalid — which
    // silently dropped Inter and Instrument Serif across the whole app.
    <html lang="en" className={`${inter.variable} ${instrumentSerif.variable}`}>
      <body>
        <PwaRegistration />
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
