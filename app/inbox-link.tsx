"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

export function InboxLink({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const router = useRouter();

  function prefetchInbox() {
    router.prefetch("/leads");
  }

  return (
    <Link
      className={className}
      href="/leads"
      onFocus={prefetchInbox}
      onMouseEnter={prefetchInbox}
      onPointerDown={prefetchInbox}
      onTouchStart={prefetchInbox}
    >
      {children}
    </Link>
  );
}
