"use client";

import { useEffect } from "react";

export type RelayInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

declare global {
  interface Window {
    __relayInstallPrompt?: RelayInstallPromptEvent;
  }
}

export function PwaRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error) => {
      console.error("Relay service worker registration failed", error);
    });

    const captureInstallPrompt = (event: Event) => {
      const promptEvent = event as RelayInstallPromptEvent;
      promptEvent.preventDefault();
      window.__relayInstallPrompt = promptEvent;
      window.dispatchEvent(new Event("relay-install-ready"));
    };
    const clearInstallPrompt = () => {
      delete window.__relayInstallPrompt;
      window.dispatchEvent(new Event("relay-install-complete"));
    };

    window.addEventListener("beforeinstallprompt", captureInstallPrompt);
    window.addEventListener("appinstalled", clearInstallPrompt);
    return () => {
      window.removeEventListener("beforeinstallprompt", captureInstallPrompt);
      window.removeEventListener("appinstalled", clearInstallPrompt);
    };
  }, []);

  return null;
}
