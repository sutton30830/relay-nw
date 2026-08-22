import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Relay NW",
    short_name: "Relay",
    description: "Missed-call leads, voicemail summaries, and owner follow-up.",
    start_url: "/leads",
    scope: "/",
    display: "standalone",
    background_color: "#f5f3ee",
    theme_color: "#0f4b44",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
