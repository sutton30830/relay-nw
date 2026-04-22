"use client";

import { useState } from "react";
import { Icon } from "@/components/icon";

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
      className="btn btn-secondary btn-sm"
      aria-live="polite"
    >
      <Icon name={copied ? "check" : "copy"} size={13} />
      {copied ? "Copied" : label}
    </button>
  );
}
