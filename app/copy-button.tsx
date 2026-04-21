"use client";

import { useState } from "react";

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function handleClick() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Ignore — clipboard not available.
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className="button-secondary text-xs"
      style={{ minHeight: 32, padding: "0.3rem 0.65rem" }}
      aria-live="polite"
    >
      {copied ? "Copied" : label}
    </button>
  );
}
