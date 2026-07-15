import type { Metadata, Viewport } from "next";
import { Instrument_Serif, Inter } from "next/font/google";
import { SiteFooter } from "@/components/site-footer";
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
  description: "A simple missed-call text follow-up system from Relay NW.",
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
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
